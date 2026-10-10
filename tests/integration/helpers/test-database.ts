import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

// The schema is imported through the package's public entry point, not its
// source path, so these tests exercise the same module graph the API does.
import * as schema from '@renderflow/db';

/**
 * Integration-test database.
 *
 * AGENTS.md section 9: credit and queue logic must never be tested against a
 * mocked database - the guarantees live in Postgres (CHECK constraints, partial
 * unique indexes, transaction isolation), so a mock would test nothing.
 *
 * Resolution order:
 *   1. `TEST_DATABASE_URL` - used by CI (a Postgres service URL);
 *   2. `DATABASE_URL`      - a developer machine's running Postgres;
 *   3. fail with a clear message rather than silently skipping the suite.
 */

// This file lives at tests/integration/helpers/, so the workspace root is three
// levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'libs', 'db', 'drizzle');

export type TestDb = NodePgDatabase<typeof schema>;

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

/**
 * Applies every migration to the target database.
 *
 * Uses `drizzle-kit migrate`, the same path CI and `pnpm db:migrate` take, so the
 * suite can never pass against a schema that production would not build.
 */
export function migrateDatabase(databaseUrl: string): void {
  // Resolve the binary directly rather than shelling out to `npx`: the jest
  // child process does not inherit the PATH that makes npx resolvable, and
  // spawning a package manager from a test is slower anyway.
  const binary = join(REPO_ROOT, 'libs', 'db', 'node_modules', '.bin', 'drizzle-kit');

  execFileSync(binary, ['migrate'], {
    cwd: join(REPO_ROOT, 'libs', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

/**
 * Verifies a real Postgres is reachable and that the credit invariants exist.
 *
 * Guards against the most dangerous failure mode for this suite: pointing at a
 * stale database whose schema does not match, which turns "the credit engine is
 * wrong" into a wall of unrelated errors.
 */
export async function assertDatabaseReady(db: TestDb): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found at ${MIGRATIONS_DIR}`);
  }

  await db.execute('SELECT 1');

  const rows = await db.execute<{ conname: string; expected: number }>(`
    SELECT conname, 1 AS expected
    FROM pg_constraint
    WHERE conname IN (
      'wallets_available_non_negative',
      'wallets_reserved_non_negative'
    )
  `);

  if (rows.rows.length !== 2) {
    throw new Error(
      'Credit CHECK constraints are missing. The suite cannot verify the credit ' +
        'invariants against this database; re-run `pnpm db:migrate`.',
    );
  }

  const indexes = await db.execute<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE indexname IN (
      'credit_ledger_reference_key',
      'credit_ledger_signup_bonus_once'
    )
  `);

  if (indexes.rows.length !== 2) {
    throw new Error('Credit idempotency indexes are missing. Re-run `pnpm db:migrate`.');
  }
}

export function createTestDb(databaseUrl: string): TestDb {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  return drizzle(pool, { schema });
}

/**
 * Truncates every table.
 *
 * AGENTS.md rule 3 permits deleting rows in TEST TEARDOWN ONLY, which is what this
 * is for. `RESTART IDENTITY CASCADE` gives each test a clean slate and avoids
 * ordering dependencies between suites.
 */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(
    'TRUNCATE TABLE assets, posts, campaigns, brands, workspace_members, workspaces, outbox_events, generation_jobs, refresh_sessions, credit_ledger, wallets, users RESTART IDENTITY CASCADE',
  );
}

/**
 * Extracts the Postgres error code from a rejected query.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose own `message` is
 * the SQL, with the real error on `.cause`. Tests assert against the code the
 * database actually returned, not the wrapper's shape.
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Full error text including the wrapped cause, for constraint-name matching. */
export function pgErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { message?: unknown };
    if (typeof record.message === 'string') {
      parts.push(record.message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Applies migrations once, then hands back a ready handle. */
export async function setupTestDatabase(): Promise<TestDb> {
  const databaseUrl = resolveTestDatabaseUrl();
  migrateDatabase(databaseUrl);
  const db = createTestDb(databaseUrl);
  await assertDatabaseReady(db);
  return db;
}

/** Direct pool access for the few places that need raw client semantics. */
export function createTestPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

export async function teardownTestDatabase(db: TestDb, pool?: Pool): Promise<void> {
  await truncateAll(db);
  if (pool !== undefined) {
    await pool.end();
  }
}

export type { PoolClient };
