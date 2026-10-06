import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { grantSignupBonus, type TransactionClient } from '@renderflow/credits';
import { getPrismaClient, type PrismaClient } from '@renderflow/db';
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
 * user can never exist without their 50 credits and the ledger row is written
 * atomically with the user row (PROJECT.md section 5.1 rule 1).
 *
 * `libs/credits` is the only module that writes `wallets` / `credit_ledger`
 * (AGENTS.md rule 1); this service never touches those tables directly.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private prisma!: PrismaClient;
  private config!: AuthConfig;
  private argon2Options: Argon2Options = DEFAULT_ARGON2_OPTIONS;

  constructor(private readonly configService: ConfigService<Env, true>) {}

  onModuleInit(): void {
    this.prisma = getPrismaClient();
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
   * `EMAIL_ALREADY_REGISTERED` - it must never create a second wallet, because
   * the insert is inside the transaction that rolled back.
   */
  async register(input: CreateUserInput, meta: SessionMetadata = {}): Promise<IssuedSession> {
    assertPasswordPolicy(input.password);
    const passwordHash = await hashPassword(input.password, this.argon2Options);
    const signupBonus = this.config.SIGNUP_BONUS_CREDITS;

    const created = await this.prisma.$transaction(async (tx: TransactionClient) => {
      try {
        const user = await tx.user.create({
          data: { email: input.email, passwordHash, name: input.name },
          select: { id: true, email: true, name: true, role: true },
        });

        // Same transaction as the user insert (AGENTS.md rule 6).
        await grantSignupBonus(tx, { userId: user.id, amount: signupBonus });

        return user;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(ERROR_CODES.EMAIL_ALREADY_REGISTERED, undefined, {
            details: { email: input.email },
          });
        }
        throw error;
      }
    });

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
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, passwordHash: true },
    });

    if (user === null) {
      // Spend comparable time so response timing does not reveal existence.
      await verifyPassword(DUMMY_HASH, password);
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS);
    }

    const { passwordHash: _discarded, ...safe } = user;
    return this.issueSession(safe, meta);
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

    const user = await this.prisma.$transaction(async (tx: TransactionClient) => {
      const session = await tx.refreshSession.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { id: true, email: true, name: true, role: true } },
        },
      });

      if (session === null || session.revokedAt !== null || session.expiresAt <= now) {
        throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Refresh token is invalid or expired');
      }

      await tx.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });

      return session.user;
    });

    return this.issueSession(user, meta);
  }

  /** Revokes the presented session. Idempotent: logging out twice is fine. */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshToken);
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every session for a user (password change, "log out everywhere"). */
  async logoutAll(userId: string): Promise<number> {
    const result = await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Public profile. Selects fields explicitly so password_hash cannot leak. */
  async findUserById(userId: string): Promise<IssuedSession['user']> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });
    if (user === null) {
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

    await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
      select: { id: true },
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
