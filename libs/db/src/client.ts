import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadDbConfig } from './db-config';
import type { DbConfig } from './db-config';
import * as schema from './schema';

/**
 * Drizzle client lifecycle.
 *
 * One `Pool` and one database handle per process. `getDb` is idempotent so a
 * NestJS provider and a worker bootstrap that both ask for the client share the
 * same pool; two pools is a common cause of connection exhaustion.
 */

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
}

/** Transaction-capable handle: the callback's argument. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

let instance: DbHandle | null = null;
/** Separate pool: session-scoped work must not land on Neon's transaction pooler. */
let directInstance: DbHandle | null = null;

/** `pg-connection-string` warns on `sslmode=require`; verify-full is the same TLS check. */
function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Hosted Postgres (Render included) can require TLS even when the pasted URL has
 * no `sslmode`. Keep this in step with `libs/db/scripts/migrate-verbose.mjs`,
 * which applies the same rule to the standalone migration runner. Local Compose
 * stays plaintext unless a URL explicitly asks for TLS.
 */
function poolOptions(config: DbConfig) {
  const parsed = new URL(config.url);
  const sslMode = parsed.searchParams.get('sslmode');

  if (sslMode === 'require') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }

  const useSsl = !isLocalHost(parsed.hostname) && sslMode !== 'disable';

  return {
    connectionString: parsed.toString(),
    ssl: useSsl ? { rejectUnauthorized: true } : undefined,
    max: config.poolMax,
    // Never hold a connection open forever behind an idle client; the reaper and
    // the health probe both care.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.statementTimeoutMs,
  };
}

export function createDb(config: DbConfig): DbHandle {
  const pool = new Pool(poolOptions(config));

  return { db: drizzle(pool, { schema }), pool };
}

export function getDb(config?: DbConfig): Database {
  return getDbHandle(config).db;
}

export function getDbHandle(config?: DbConfig): DbHandle {
  if (instance === null) {
    instance = createDb(config ?? loadDbConfig());
  }
  return instance;
}

/**
 * Direct (unpooled) handle for session-scoped Postgres work.
 *
 * Neon's transaction pooler does not pin a backend connection, so an advisory
 * lock acquired there can be released - or read as free - by another client.
 * Migrations have the same problem with prepared statements. This handle uses
 * `DATABASE_URL_UNPOOLED`; local setups fall back to `DATABASE_URL`.
 */
export function getDirectDbHandle(config?: DbConfig): DbHandle {
  if (directInstance === null) {
    const base = config ?? loadDbConfig();
    directInstance = createDb({ ...base, url: base.urlUnpooled ?? base.url });
  }
  return directInstance;
}

/** Registered as a drain so SIGTERM closes both pools before the process exits. */
export async function disconnectDb(): Promise<void> {
  if (instance !== null) {
    await instance.pool.end();
    instance = null;
  }
  if (directInstance !== null) {
    await directInstance.pool.end();
    directInstance = null;
  }
}

/** Test seam: forget both singletons without closing their pools. */
export function resetDbForTests(): void {
  instance = null;
  directInstance = null;
}

/**
 * The current handle, or null - WITHOUT creating one.
 *
 * `getDbHandle` is a factory as well as an accessor, so asking it a question
 * creates a pool when there was none. A caller that wants to close the pool it
 * opened needs to know whether it opened one; using `getDbHandle` for that would
 * manufacture the very thing it is trying to clean up.
 */
export function peekDbHandle(): DbHandle | null {
  return instance;
}

/**
 * A session-scoped Postgres advisory lock.
 *
 * Used by the reaper so only one instance sweeps at a time. Postgres is the
 * right place for it rather than Redis: it is the dependency that already has to
 * be up for the reaper to do anything, and a reaper that cannot start because
 * its lock store is down is a reaper that cannot recover anything.
 *
 * The lock is HELD BY A CONNECTION, so it needs a dedicated client from the pool
 * rather than one taken and returned. Pinning a pooled client for a long-running
 * process is normally a bad idea; it is safe here because the holder is exactly
 * one process and the pool is sized for the workers as well.
 */
export interface AdvisoryLock {
  /** False when another process already holds it; there is nothing to release. */
  readonly acquired: boolean;
  release: () => Promise<void>;
}

export async function tryAcquireAdvisoryLock(pool: Pool, key: number): Promise<AdvisoryLock> {
  const client = await pool.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );

    if (result.rows[0]?.locked !== true) {
      client.release();
      return { acquired: false, release: async () => {} };
    }

    return {
      acquired: true,
      release: async () => {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } finally {
          // Returned even when the unlock failed, or the pool loses a slot on
          // every reaper restart.
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

/**
 * Closes the pool even if a caller forgot, so a crashed test cannot leave the
 * integration database with open connections.
 */
export async function shutdownDb(): Promise<void> {
  await disconnectDb();
}

export { schema };
