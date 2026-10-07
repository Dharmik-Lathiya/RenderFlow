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
 * Closes the pool even if a caller forgot, so a crashed test cannot leave the
 * integration database with open connections.
 */
export async function shutdownDb(): Promise<void> {
  await disconnectDb();
}

export { schema };
