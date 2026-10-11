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

export function createDb(config: DbConfig): DbHandle {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    // Never hold a connection open forever behind an idle client; the reaper and
    // the health probe both care.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.statementTimeoutMs,
  });

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

/** Registered as a drain so SIGTERM closes the pool before the process exits. */
export async function disconnectDb(): Promise<void> {
  if (instance !== null) {
    await instance.pool.end();
    instance = null;
  }
}

/** Test seam: forget the singleton without closing the pool. */
export function resetDbForTests(): void {
  instance = null;
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
