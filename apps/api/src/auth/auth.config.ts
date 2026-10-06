import { z } from 'zod';

import { DEFAULT_ARGON2_OPTIONS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './password';

/**
 * Auth configuration.
 *
 * Reads `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `TOKEN_ENCRYPTION_KEY` and
 * fails at boot if they are missing or too weak. A default secret in a dev
 * environment is a real vulnerability once that environment is reachable, so
 * there is no fallback value here (AGENTS.md section 10).
 */

export const MIN_SECRET_LENGTH = 32;

export const authConfigSchema = z.object({
  JWT_ACCESS_SECRET: z
    .string()
    .min(MIN_SECRET_LENGTH, `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
  JWT_REFRESH_SECRET: z
    .string()
    .min(MIN_SECRET_LENGTH, `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
  /** e.g. `15m`, `7d`. */
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
  /**
   * base64-encoded 32 bytes for AES-256-GCM.
   *
   * Optional in Phase 1 and absent from many test environments; the Phase 7
   * social-account code validates it as required before storing any token.
   */
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().nonnegative().default(50),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export class AuthConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid auth configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AuthConfigError';
  }
}

/** Reads auth config from a plain environment record (used at boot). */
export function loadAuthConfig(source: NodeJS.ProcessEnv = process.env): AuthConfig {
  const result = authConfigSchema.safeParse(source);
  if (!result.success) {
    throw new AuthConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Keys the auth layer needs, in the order they are validated. */
export const AUTH_CONFIG_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
  'TOKEN_ENCRYPTION_KEY',
  'SIGNUP_BONUS_CREDITS',
] as const;

/** Minimal view of `ConfigService`, so this module does not import @nestjs/config. */
export interface ConfigReader {
  get<T>(key: string): T | undefined;
}

/**
 * Reads auth config from a `ConfigService`.
 *
 * A `ConfigService` is not a plain object: its values live in an internal store,
 * so passing the instance itself to a zod schema over an env-shaped record
 * silently yields `undefined` for every key. Values are therefore extracted by
 * key and validated as an object.
 */
export function loadAuthConfigFrom(reader: ConfigReader): AuthConfig {
  const values: Record<string, unknown> = {};

  for (const key of AUTH_CONFIG_KEYS) {
    const value = reader.get<unknown>(key);
    // Omit absent optional keys so schema defaults apply.
    if (value !== undefined) {
      values[key] = value;
    }
  }

  const result = authConfigSchema.safeParse(values);
  if (!result.success) {
    throw new AuthConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

// --- cookie names ---------------------------------------------------------

export const ACCESS_TOKEN_COOKIE = 'rf_access';
export const REFRESH_TOKEN_COOKIE = 'rf_refresh';
export const CSRF_COOKIE = 'rf_csrf';
/** Non-httpOnly: the browser JS must read this to echo it in the header. */
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAgeSeconds: number;
}

/**
 * Access and refresh cookies are `httpOnly` + `SameSite=Lax`, and `Secure` in
 * production. The CSRF cookie is readable by JS by design - it is not a secret,
 * it is the value the client echoes back in a header, which is what makes a
 * cross-site form post impossible.
 */
export function authCookieOptions(
  env: 'development' | 'test' | 'production',
  ttlSeconds: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: env === 'production',
    sameSite: 'lax',
    path: '/',
    maxAgeSeconds: ttlSeconds,
  };
}

/** Seconds per supported duration unit. */
const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** Durations are config strings like `15m` / `7d`; cookies need seconds. */
export function ttlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) {
    throw new AuthConfigError([`Unparseable duration "${ttl}"; expected e.g. 15m or 7d`]);
  }
  const multiplier = TTL_UNITS[match[2] ?? ''];
  if (multiplier === undefined) {
    throw new AuthConfigError([`Unsupported duration unit "${match[2] ?? ''}"`]);
  }
  return Number(match[1]) * multiplier;
}

export { DEFAULT_ARGON2_OPTIONS, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
