/**
 * @renderflow/db
 *
 * Drizzle schema, client lifecycle and validated configuration.
 *
 * IMPORTANT: `libs/credits` is the only module allowed to write `wallets` or
 * `credit_ledger` (AGENTS.md rule 1). Every other consumer goes through its
 * exported API.
 */

export * from './client';
export * from './db-config';
export * from './schema';
