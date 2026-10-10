import { and, eq, isNull } from 'drizzle-orm';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { grantSignupBonus, isUniqueViolation } from '@renderflow/credits';
import {
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
import { loadAuthConfigFrom, ttlSeconds, type AuthConfig } from './auth.config';
import {
  DEFAULT_ARGON2_OPTIONS,
  assertPasswordPolicy,
  generateRefreshToken,
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

  constructor(private readonly configService: ConfigService<Env, true>) {}

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
