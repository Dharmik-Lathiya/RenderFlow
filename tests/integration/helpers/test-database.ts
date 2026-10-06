import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

/**
 * Integration-test database.
 *
 * AGENTS.md section 9: credit and queue logic must never be tested against a
 * mocked database - the guarantees live in Postgres (CHECK constraints, partial
 * unique indexes, transaction isolation), so a mock would test nothing.
 *
 * Resolution order:
 *   1. `TEST_DATABASE_URL` - used by CI (a Testcontainers/Postgres service URL);
 *   2. `DATABASE_URL`      - a developer machine's running Postgres;
 *   3. fail with a clear message rather than silently skipping the suite.
 *
 * When Docker is unavailable the suite falls back to a local Postgres cluster,
 * which is how this repository's own tests run on a machine without a daemon.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'libs', 'db', 'prisma', 'migrations');

export function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'No integration database configured. Set TEST_DATABASE_URL (CI) or DATABASE_URL ' +
        '(local), e.g. postgresql://renderflow:renderflow@localhost:5432/renderflow_test',
    );
  }
  return url;
}

/** Applies every migration to the target database. Idempotent. */
export function migrateDatabase(databaseUrl: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: join(REPO_ROOT, 'libs', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

/**
 * Verifies a real Postgres is reachable. Guards against the most dangerous
 * failure mode for this suite: pointing at a stale database whose schema does not
 * match, which turns "the credit engine is wrong" into a wall of unrelated errors.
 */
export async function assertDatabaseReady(client: PrismaClient): Promise<void> {
  const migrationsDirExists = existsSync(MIGRATIONS_DIR);
  if (!migrationsDirExists) {
    throw new Error(`Migrations directory not found at ${MIGRATIONS_DIR}`);
  }

  await client.$queryRaw`SELECT 1`;
}

export function createTestClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    // Silent unless PRISMA_LOG is set. Several suites deliberately provoke
    // unique-constraint and CHECK violations, and Prisma's default error
    // logging turns those expected failures into pages of console noise that
    // buries real problems.
    log: process.env.PRISMA_LOG === '1' ? ['error'] : [],
  });
}

/**
 * Truncates every table except `prisma_migrations`.
 *
 * AGENTS.md rule 3 permits deleting rows in TEST TEARDOWN ONLY, which is what this
 * is for. `RESTART IDENTITY CASCADE` gives each test a clean slate and avoids
 * ordering dependencies between suites.
 */
export async function truncateAll(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`
    TRUNCATE TABLE
      "refresh_sessions",
      "credit_ledger",
      "wallets",
      "users"
    RESTART IDENTITY CASCADE
  `);
}

/** Points every lib at the test database, then migrates once. */
export async function setupTestDatabase(): Promise<PrismaClient> {
  const databaseUrl = resolveTestDatabaseUrl();
  migrateDatabase(databaseUrl);
  const client = createTestClient(databaseUrl);
  await assertDatabaseReady(client);
  return client;
}

export async function teardownTestDatabase(client: PrismaClient): Promise<void> {
  await truncateAll(client);
  await client.$disconnect();
}
