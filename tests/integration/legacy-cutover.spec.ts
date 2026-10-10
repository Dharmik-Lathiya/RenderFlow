import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';

import { resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * The pre-Drizzle (Prisma) cutover path.
 *
 * The Prisma schema and the Drizzle schema are NOT schema-compatible: Prisma's
 * client generated `id` and `updated_at` values in application code and left those
 * columns with no database default, while Drizzle relies on `gen_random_uuid()`
 * and `now()`. A database created under Prisma therefore cannot simply be pointed
 * at by `drizzle-kit migrate` - it would try to CREATE TABLE over existing tables.
 *
 * `scripts/db-adopt-legacy.sh` is the supported way in. This suite is the
 * regression test for it: it builds a faithful Prisma-era database containing
 * data, runs the adoption, and asserts the result is equivalent to a freshly
 * migrated one.
 *
 * Without this, the only evidence the path works is a note in PROJECT.md saying it
 * should - which is exactly the kind of claim that quietly rots.
 *
 * It runs against its own throwaway database and never touches the shared
 * integration one.
 */

const REPO_ROOT = __dirname.replace(/\/tests\/integration$/, '');
const SCRIPT = `${REPO_ROOT}/scripts/db-adopt-legacy.sh`;
const DB_NAME = 'renderflow_legacy_cutover_test';

describe('legacy (pre-Drizzle) database adoption', () => {
  let admin: Pool;
  let url: string;

  beforeAll(async () => {
    const base = new URL(resolveTestDatabaseUrl());
    url = `postgresql://${base.username}:${base.password}@${base.hostname}:${base.port || 5432}/${DB_NAME}`;
    admin = new Pool({ connectionString: url.replace(`/${DB_NAME}`, '/postgres') });

    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });

  afterAll(async () => {
    // Always clean up, including on failure: a stray database would fail the next
    // run with "already exists" and mask the real result.
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => undefined);
    await admin.end();
  });

  /**
   * Builds the exact schema Prisma produced, including the hand-written credit
   * constraints. Runs against the throwaway database, not the admin one.
   */
  async function createPrismaEraSchema(): Promise<void> {
    await withDb((db) =>
      db.query(`
      CREATE TYPE "UserRole" AS ENUM ('ADMIN','MEMBER');
      CREATE TYPE "CreditEntryType" AS ENUM
        ('SIGNUP_BONUS','PURCHASE','RESERVE','CAPTURE','REFUND','ADJUSTMENT','EXPIRY');

      CREATE TABLE users (
        id uuid PRIMARY KEY NOT NULL,
        email varchar(320) NOT NULL,
        password_hash varchar(255) NOT NULL,
        name varchar(120) NOT NULL,
        role "UserRole" DEFAULT 'MEMBER' NOT NULL,
        email_verified_at timestamptz,
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX users_email_key ON users(email);

      CREATE TABLE wallets (
        user_id uuid PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        available integer DEFAULT 0 NOT NULL,
        reserved integer DEFAULT 0 NOT NULL,
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamptz NOT NULL
      );

      CREATE TABLE credit_ledger (
        id uuid PRIMARY KEY NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_type "CreditEntryType" NOT NULL,
        amount integer NOT NULL,
        reference_type varchar(40),
        reference_id varchar(64),
        note varchar(255),
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      );

      CREATE TABLE refresh_sessions (
        id uuid PRIMARY KEY NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        user_agent varchar(255),
        ip_address varchar(64),
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      CREATE UNIQUE INDEX refresh_sessions_token_hash_key ON refresh_sessions(token_hash);

      -- The credit guarantees Prisma could not express, hand-written as they were.
      ALTER TABLE wallets ADD CONSTRAINT wallets_available_non_negative CHECK (available >= 0);
      ALTER TABLE wallets ADD CONSTRAINT wallets_reserved_non_negative CHECK (reserved >= 0);
      CREATE UNIQUE INDEX credit_ledger_reference_key
        ON credit_ledger(reference_type, reference_id, entry_type) WHERE reference_type IS NOT NULL;
      CREATE UNIQUE INDEX credit_ledger_signup_bonus_once
        ON credit_ledger(user_id) WHERE entry_type = 'SIGNUP_BONUS';
    `),
    );
  }

  function withDb<T>(fn: (client: Pool) => Promise<T>): Promise<T> {
    const client = new Pool({ connectionString: url, max: 1 });
    return fn(client).finally(() => client.end());
  }

  it('adopts a Prisma-era database without losing data', async () => {
    await withDb(async (db) => {
      await createPrismaEraSchema();

      // Real rows, so "did not lose anything" is a claim and not a hope.
      await db.query(
        `INSERT INTO users (id,email,password_hash,name,updated_at)
         VALUES ('44444444-4444-4444-8444-444444444444','legacy@example.com','x','Legacy User', now())`,
      );
      await db.query(
        `INSERT INTO wallets (user_id,available,reserved,updated_at)
         VALUES ('44444444-4444-4444-8444-444444444444',50,0, now())`,
      );
      await db.query(
        // `id` is supplied explicitly: under Prisma this column had no database
        // default, which is the entire reason the cutover needs a migration.
        `INSERT INTO credit_ledger
           (id,user_id,entry_type,amount,reference_type,reference_id,created_at)
         VALUES ('55555555-5555-4555-8555-555555555555',
                 '44444444-4444-4444-8444-444444444444',
                 'SIGNUP_BONUS',50,'SYSTEM',NULL, now())`,
      );
    });

    const output = execFileSync(SCRIPT, [url], { encoding: 'utf8', timeout: 120_000 });
    expect(output).toContain('migrations applied successfully');

    await withDb(async (db) => {
      // 1. The data survived.
      const users = await db.query<{ email: string; name: string }>(
        'SELECT email, name FROM users',
      );
      expect(users.rows).toEqual([{ email: 'legacy@example.com', name: 'Legacy User' }]);

      const wallet = await db.query<{ available: number }>(
        'SELECT available FROM wallets WHERE user_id = $1',
        ['44444444-4444-4444-8444-444444444444'],
      );
      expect(wallet.rows[0]?.available).toBe(50);

      const ledger = await db.query<{ amount: number; entry_type: string }>(
        'SELECT amount, entry_type FROM credit_ledger',
      );
      expect(ledger.rows).toEqual([{ amount: 50, entry_type: 'SIGNUP_BONUS' }]);

      // The id the client supplied under Prisma is preserved; adoption adds a
      // default going forward without rewriting what already exists.
      const ledgerId = await db.query<{ id: string }>('SELECT id FROM credit_ledger');
      expect(ledgerId.rows[0]?.id).toBe('55555555-5555-4555-8555-555555555555');

      // 2. Every table now exists, including the Phase 2 and 3 ones.
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
      );
      const names = tables.rows.map((r) => r.table_name);
      for (const expected of [
        'users',
        'wallets',
        'credit_ledger',
        'refresh_sessions',
        'pricing_rules',
        'generation_jobs',
        'outbox_events',
        'workspaces',
        'workspace_members',
        'brands',
        'campaigns',
        'posts',
        'assets',
      ]) {
        expect(names).toContain(expected);
      }

      // 3. The column defaults Drizzle depends on now exist. Without these an
      //    insert that omits `id` fails with a not-null violation.
      const defaults = await db.query<{ column_default: string | null }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name='users' AND column_name IN ('id','updated_at')`,
      );
      expect(defaults.rows.every((r) => r.column_default !== null)).toBe(true);

      const idDefault = await db.query<{ column_default: string }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name='users' AND column_name='id'`,
      );
      expect(idDefault.rows[0]?.column_default).toContain('gen_random_uuid');

      // 4. The credit guarantees are still enforced after adoption.
      await expect(
        db.query('UPDATE wallets SET available = -1 WHERE user_id = $1', [
          '44444444-4444-4444-8444-444444444444',
        ]),
      ).rejects.toThrow(/wallets_available_non_negative/);

      // 5. The migration history is recorded, so re-running is a no-op rather
      //    than a second attempt to CREATE existing tables.
      const history = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations',
      );
      expect(Number(history.rows[0]?.n)).toBeGreaterThan(1);
    });
  }, 180_000);

  it('refuses an empty database, where plain migrate is the right answer', () => {
    // Adopting an empty database would record a baseline for tables that do not
    // exist, and every later migration would then fail confusingly.
    const emptyUrl = url.replace(DB_NAME, 'postgres');
    expect(() => execFileSync(SCRIPT, [emptyUrl], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  it('refuses to adopt a database that already has migration history', () => {
    // Re-adopting would insert a second baseline row and leave the history
    // claiming migrations ran in an order they did not.
    expect(() => execFileSync(SCRIPT, [url], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
