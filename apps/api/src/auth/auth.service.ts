import { randomBytes } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { grantSignupBonus, isUniqueViolation } from '@renderflow/credits';
import {
  authTokens,
  getDb,
  refreshSessions,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type DbTransaction,
} from '@renderflow/db';
import { createLogger } from '@renderflow/observability';

import type { Env } from '../config/env';
import {
  EMAIL_SENDER,
  passwordResetEmail,
  verificationEmail,
  type EmailSender,
} from '../email/email';
import { loadAuthConfigFrom, ttlSeconds, type AuthConfig } from './auth.config';
import { normalizeEmail } from './auth.dto';
import {
  DEFAULT_ARGON2_OPTIONS,
  assertPasswordPolicy,
  generateRefreshToken,
  hashAuthToken,
  hashPassword,
  hashRefreshToken,
  verifyPassword,
  type Argon2Options,
} from './password';
import { generateCsrfToken, signAccessToken } from './token.service';

/**
 * Resolved lazily so the module can be imported by a unit test without app
 * configuration; `main.ts` injects the real logger at boot.
 */
let logger: ReturnType<typeof createLogger> | null = null;

/** Wires the auth logger at boot. Called once from `main.ts`. */
export function configureAuthLogger(instance: ReturnType<typeof createLogger>): void {
  logger = instance;
}

function log(): ReturnType<typeof createLogger> {
  logger ??= createLogger({ service: 'auth' });
  return logger;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
}

export interface IssuedSession {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  csrfToken: string;
}

export interface SessionMetadata {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/**
 * Registration, login, refresh and logout.
 *
 * The signup bonus is granted by `libs/credits` inside THIS transaction, so a
 * user can never exist without their credits and the ledger row is written
 * atomically with the user row (PROJECT.md section 5.1 rule 1).
 *
 * `libs/credits` is the only module that writes `wallets` / `credit_ledger`
 * (AGENTS.md rule 1); this service never touches those tables directly.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private db!: Database;
  private config!: AuthConfig;
  private argon2Options: Argon2Options = DEFAULT_ARGON2_OPTIONS;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  onModuleInit(): void {
    this.db = getDb();
    this.config = loadAuthConfigFrom(this.configService);
  }

  /**
   * Test seam: use cheap argon2 parameters so the suite does not spend
   * ~50ms per hash. Production keeps the OWASP defaults.
   */
  setArgon2Options(options: Argon2Options): void {
    this.argon2Options = options;
  }

  /**
   * Creates a user and grants the signup bonus in one transaction.
   *
   * Concurrency: two simultaneous registrations of the same email produce one
   * user. The loser hits the unique index on `users.email` and gets
   * `EMAIL_ALREADY_REGISTERED`; it must never create a second wallet, because
   * the insert is inside the transaction that rolled back.
   */
  async register(input: CreateUserInput, meta: SessionMetadata = {}): Promise<IssuedSession> {
    assertPasswordPolicy(input.password);
    const passwordHash = await hashPassword(input.password, this.argon2Options);
    const signupBonus = this.config.SIGNUP_BONUS_CREDITS;

    let created: { id: string; email: string; name: string; role: string };

    try {
      created = await this.db.transaction(async (tx: DbTransaction) => {
        const [user] = await tx
          .insert(users)
          .values({ email: input.email, passwordHash, name: input.name })
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
          });

        if (user === undefined) {
          throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'User insert returned no row');
        }

        // Same transaction as the user insert (AGENTS.md rule 6).
        await grantSignupBonus(tx, { userId: user.id, amount: signupBonus });

        // A personal workspace with the new user as OWNER, in the same
        // transaction. Every workspace-scoped query needs a membership to check,
        // so a user without one could not create a brand and would have no way to
        // diagnose why. Creating it here rather than on first use means there is
        // no window where the account exists but the app cannot be used.
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: `${input.name}'s workspace`, ownerId: user.id })
          .returning({ id: workspaces.id });

        if (workspace === undefined) {
          throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Workspace insert returned no row');
        }

        await tx.insert(workspaceMembers).values({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'OWNER',
        });

        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(ERROR_CODES.EMAIL_ALREADY_REGISTERED, undefined, {
          details: { email: input.email },
        });
      }
      throw error;
    }

    log().info({ userId: created.id, signupBonus }, 'user registered with signup bonus');

    return this.issueSession(created, meta);
  }

  /**
   * Verifies credentials.
   *
   * Returns `INVALID_CREDENTIALS` for both an unknown email and a wrong password,
   * so the endpoint cannot be used to enumerate registered addresses.
   */
  async login(email: string, password: string, meta: SessionMetadata = {}): Promise<IssuedSession> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const user = rows[0];

    if (user === undefined) {
      // Spend comparable time so response timing does not reveal existence.
      await verifyPassword(DUMMY_HASH, password);
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS);
    }

    return this.issueSession(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      meta,
    );
  }

  /**
   * Rotates a refresh token.
   *
   * The presented token is revoked and a new one issued, so a stolen token is
   * usable at most once and its reuse is visible (the row is already revoked).
   */
  async refresh(refreshToken: string, meta: SessionMetadata = {}): Promise<IssuedSession> {
    const tokenHash = hashRefreshToken(refreshToken);
    const now = new Date();

    const user = await this.db.transaction(async (tx: DbTransaction) => {
      const rows = await tx
        .select({
          id: refreshSessions.id,
          expiresAt: refreshSessions.expiresAt,
          revokedAt: refreshSessions.revokedAt,
          userId: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        })
        .from(refreshSessions)
        .innerJoin(users, eq(refreshSessions.userId, users.id))
        .where(eq(refreshSessions.tokenHash, tokenHash))
        .limit(1);

      const session = rows[0];

      if (session === undefined || session.revokedAt !== null || session.expiresAt <= now) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Refresh token is invalid or expired');
      }

      await tx
        .update(refreshSessions)
        .set({ revokedAt: now })
        .where(eq(refreshSessions.id, session.id));

      return {
        id: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      };
    });

    return this.issueSession(user, meta);
  }

  /** Revokes the presented session. Idempotent: logging out twice is fine. */
  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(refreshSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshSessions.tokenHash, hashRefreshToken(refreshToken)),
          isNull(refreshSessions.revokedAt),
        ),
      );
  }

  /** Revokes every session for a user (password change, "log out everywhere"). */
  async logoutAll(userId: string): Promise<number> {
    const rows = await this.db
      .update(refreshSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)))
      .returning({ id: refreshSessions.id });
    return rows.length;
  }

  /** Public profile. Selects fields explicitly so passwordHash cannot leak. */
  async findUserById(userId: string): Promise<IssuedSession['user']> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = rows[0];
    if (user === undefined) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { details: { userId } });
    }
    return user;
  }

  /**
   * Starts a password reset.
   *
   * Always succeeds, whether or not the address is registered: a different answer
   * for an unknown address turns this endpoint into an account-existence oracle,
   * which is exactly what credential stuffing feeds on. The caller gets 202 and a
   * registered user gets a mail.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const rows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalizeEmail(rawEmail)))
      .limit(1);

    const user = rows[0];
    if (user === undefined) {
      return;
    }

    const ttlMinutes = this.configService.get('PASSWORD_RESET_TTL_MINUTES', { infer: true });
    const token = await this.issueAuthToken(user.id, 'PASSWORD_RESET', ttlMinutes * 60_000);
    const link = `${this.webBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

    await this.email.send({ to: user.email, ...passwordResetEmail(link, ttlMinutes) });
  }

  /**
   * Completes a password reset.
   *
   * Consuming the token and changing the password are separate statements, so the
   * token is burned first: a failure while writing the password must not leave a
   * link that still works. Every existing session is revoked in the same
   * transaction as the password change - a reset is also "log out everywhere",
   * otherwise whoever had the old password keeps their session.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    assertPasswordPolicy(password);
    const userId = await this.consumeAuthToken(token, 'PASSWORD_RESET');
    const passwordHash = await hashPassword(password, this.argon2Options);

    await this.db.transaction(async (tx: DbTransaction) => {
      await tx
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, userId));

      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
    });
  }

  /**
   * Sends (or re-sends) an email-verification link.
   *
   * Silent when the address is already verified: the caller is authenticated, and
   * telling them "nothing to do" is more useful than a new link that verifies
   * nothing.
   */
  async requestEmailVerification(userId: string): Promise<void> {
    const rows = await this.db
      .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = rows[0];
    if (user === undefined || user.verifiedAt !== null) {
      return;
    }

    const ttlHours = this.configService.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true });
    const token = await this.issueAuthToken(userId, 'EMAIL_VERIFICATION', ttlHours * 3_600_000);
    const link = `${this.webBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;

    await this.email.send({ to: user.email, ...verificationEmail(link, ttlHours) });
  }

  /** Marks the address verified. A used or expired link is `INVALID_TOKEN`. */
  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeAuthToken(token, 'EMAIL_VERIFICATION');

    await this.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  }

  /**
   * Issues a one-shot token, invalidating any earlier unused one of the same kind.
   *
   * Only the digest is stored. Invalidation happens in the same transaction as the
   * insert so a user who clicks "send again" three times has exactly one working
   * link - the newest.
   */
  private async issueAuthToken(
    userId: string,
    purpose: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION',
    ttlMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await this.db.transaction(async (tx: DbTransaction) => {
      await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(authTokens.userId, userId),
            eq(authTokens.purpose, purpose),
            isNull(authTokens.usedAt),
          ),
        );

      await tx.insert(authTokens).values({
        userId,
        purpose,
        tokenHash: hashAuthToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      });
    });

    return token;
  }

  /**
   * Claims a token exactly once.
   *
   * The guard is the decision: `used_at IS NULL` plus `expires_at > now()` in the
   * WHERE clause means two simultaneous clicks produce one winner, with no
   * read-then-write window.
   */
  private async consumeAuthToken(
    token: string,
    purpose: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION',
  ): Promise<string> {
    const trimmed = token.trim();
    if (trimmed === '') {
      throw new AppError(ERROR_CODES.INVALID_TOKEN, 'This link is invalid or has expired.');
    }

    const [claimed] = await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, hashAuthToken(trimmed)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: authTokens.userId });

    if (claimed === undefined) {
      // One message for unknown / used / expired: distinguishing them tells a
      // caller whether a token ever existed.
      throw new AppError(ERROR_CODES.INVALID_TOKEN, 'This link is invalid or has expired.');
    }

    return claimed.userId;
  }

  private webBaseUrl(): string {
    return this.configService.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  private async issueSession(
    user: { id: string; email: string; name: string; role: string },
    meta: SessionMetadata,
  ): Promise<IssuedSession> {
    const accessTtl = ttlSeconds(this.config.JWT_ACCESS_TTL);
    const refreshTtl = ttlSeconds(this.config.JWT_REFRESH_TTL);

    const access = signAccessToken({
      userId: user.id,
      role: user.role,
      secret: this.config.JWT_ACCESS_SECRET,
      ttlSeconds: accessTtl,
    });

    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + refreshTtl * 1000);

    await this.db.insert(refreshSessions).values({
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshTokenExpiresAt,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ipAddress ?? null,
    });

    return {
      user,
      accessToken: access.token,
      accessTokenExpiresInSeconds: access.expiresInSeconds,
      refreshToken,
      refreshTokenExpiresAt,
      csrfToken: generateCsrfToken(),
    };
  }
}

/**
 * A syntactically valid argon2 hash of a random string. Verifying against it on
 * an unknown email makes the "no such user" path cost roughly the same as a real
 * check, so response time does not leak whether an address is registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Y7gQ1p2Xh8v0kQKf3nR6tS9uW4yZ1aB2cD3eF5gH7jK9mN0pQ';
