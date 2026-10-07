import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * `DATABASE_URL` is read from the environment at both generate and migrate time,
 * so migrations are applied to whatever database the process is pointed at - the
 * compose Postgres by default, the integration database under `pnpm test:int`.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://renderflow:renderflow@localhost:5432/renderflow',
  },
  strict: true,
  verbose: true,
});
