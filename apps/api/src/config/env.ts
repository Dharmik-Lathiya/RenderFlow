import { z } from 'zod';

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
