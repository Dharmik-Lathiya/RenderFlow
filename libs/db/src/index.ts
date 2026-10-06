/**
 * @renderflow/db
 *
 * Prisma client lifecycle and validated configuration.
 *
 * IMPORTANT: `libs/credits` is the only module allowed to write to `wallets` or
 * `credit_ledger` (AGENTS.md rule 1). Every other consumer goes through its
 * exported API.
 */

export * from '@prisma/client';

export * from './client';
export * from './db-config';
