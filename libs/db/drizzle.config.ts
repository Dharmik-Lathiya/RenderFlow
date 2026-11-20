import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Migrations must use a direct (unpooled) Postgres connection. Neon's transaction
 * pooler cannot keep the session state drizzle-kit needs; `DATABASE_URL_UNPOOLED`
 * is pulled from Neon alongside the pooled `DATABASE_URL`. Local Compose and
 * Testcontainers have no direct URL, so they fall back to `DATABASE_URL`.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      'postgresql://renderflow:renderflow@localhost:5432/renderflow',
  },
  strict: true,
  verbose: true,
});
