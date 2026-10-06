/**
 * Environment for the integration suites.
 *
 * Kept in its own module because `AppModule` validates `process.env` at import
 * time: any file that imports it must have set these values first, and ES module
 * imports are hoisted. Importing `./env` before `app.module` is therefore the
 * only way to guarantee ordering.
 */

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:3000',
  // 60+ chars, which is what the config's minimum-length rule enforces.
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-definitely-long-enough-0001',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-definitely-long-enough-0002',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  SIGNUP_BONUS_CREDITS: '50',
  // Cheap argon2 so the suite is not dominated by hashing (~50ms each otherwise).
  ARGON2_MEMORY_COST: '8',
  ARGON2_TIME_COST: '1',
  METRICS_ENABLED: 'false',
};

export const UNIQUE_PASSWORD = 'IntegrationPass123';

/**
 * Applied as a side effect of importing this module.
 *
 * This file deliberately has NO imports: ES module imports are evaluated in
 * source order, so its body runs before any later import in the importing file.
 * That is what guarantees `process.env` satisfies `envSchema` before
 * `AppModule` is evaluated (it calls `ConfigModule.forRoot({ validate })` at
 * module scope, which would otherwise throw).
 */
Object.assign(process.env, TEST_ENV);

/**
 * Quiets the app's own structured logs during the suite.
 *
 * A 20-way concurrency test logs 20 registrations, and with pino at `info` that
 * noise buries real failures. `LOG_LEVEL` above is the default; set
 * `RENDERFLOW_TEST_LOGS=1` to see them when debugging a failing suite.
 */
if (process.env.RENDERFLOW_TEST_LOGS !== '1') {
  process.env.LOG_LEVEL = 'silent';
}

/** Cookie names, mirrored from apps/api/src/auth/auth.config.ts. */
export const ACCESS_COOKIE = 'rf_access';
export const REFRESH_COOKIE = 'rf_refresh';
export const CSRF_COOKIE_NAME = 'rf_csrf';
export const CSRF_HEADER = 'x-csrf-token';
