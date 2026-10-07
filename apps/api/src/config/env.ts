import { z } from 'zod';

import { rateLimitSpecSchema } from '../ratelimit/rate-limit.config';

/**
 * Validated process configuration.
 *
 * AGENTS.md rule: "Config via @nestjs/config with a validated schema. Never read
 * `process.env` directly outside the config module." This module is that place;
 * every other file receives a typed `Env` object.
 *
 * Fail-fast matters here: an API that boots with a bad DATABASE_URL fails much
 * later, in a worker, with a much worse error message.
 */

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  /** Comma separated. Cookies require an explicit origin list, never `*`. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- auth (further validated by loadAuthConfig) ---
  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  /** Free credits granted at signup: the only source of the 50 (AGENTS.md rule 6). */
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().nonnegative().default(50),

  // --- auth test seam: cheap argon2 params for test/CI only ---
  ARGON2_MEMORY_COST: z.coerce.number().int().positive().optional(),
  ARGON2_TIME_COST: z.coerce.number().int().positive().optional(),

  // --- cookies / CSRF ---
  CSRF_EXEMPT_PATHS: z.string().default(''),

  // --- rate limiting (PROJECT.md section 14.10, section 15) ---
  /**
   * Spec format is `<count>/<window>`, e.g. `10/15m`. `0` disables one rule.
   *
   * Validated as a string rather than as numbers so a typo such as
   * `RATE_LIMIT_LOGIN_IP=10/15minutes` or a half-configured pair cannot leave an
   * endpoint silently unlimited.
   */
  RATE_LIMIT_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((value) => (typeof value === 'boolean' ? value : value !== 'false')),
  RATE_LIMIT_LOGIN_IP: rateLimitSpecSchema.default('10/15m'),
  RATE_LIMIT_LOGIN_ACCOUNT: rateLimitSpecSchema.default('30/1h'),
  RATE_LIMIT_REGISTER_IP: rateLimitSpecSchema.default('5/1h'),
  RATE_LIMIT_REFRESH_IP: rateLimitSpecSchema.default('60/15m'),

  // --- database logging ---
  DB_LOG_LEVELS: z.string().default('warn,error'),

  /** 0 disables /metrics. */
  METRICS_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((value) => (typeof value === 'boolean' ? value : value !== 'false')),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/**
 * Cookie auth needs `credentials: true`, which browsers forbid with a `*`
 * origin, so a wildcard here would silently break the web app.
 */
export function assertCorsIsExplicit(env: Env): void {
  if (corsOrigins(env).includes('*')) {
    throw new EnvValidationError([
      'CORS_ORIGINS must list explicit origins; "*" is incompatible with cookie auth',
    ]);
  }
}
