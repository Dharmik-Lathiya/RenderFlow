import { eq, sql } from 'drizzle-orm';

import { wallets, type Database, type DbTransaction } from '@renderflow/db';

import { CreditError, type CreditTransaction, type LedgerEntry } from './signup-bonus';

export interface WalletBalance {
  userId: string;
  available: number;
  reserved: number;
  /** available + reserved: the user's total credit position. */
  total: number;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Wallet reads.
 *
 * Read-only: no mutation of `wallets` or `credit_ledger` happens here
 * (AGENTS.md rule 1). `libs/credits` is the only module allowed to write those
 * tables, and this file is deliberately on the safe side of that line.
 */

export async function getBalance(tx: CreditTransaction, userId: string): Promise<WalletBalance> {
  const wallet = await tx
    .select({
      userId: wallets.userId,
      available: wallets.available,
      reserved: wallets.reserved,
    })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);

  const row = wallet[0];
  if (row === undefined) {
    throw new CreditError(`No wallet for user ${userId}`, 'WALLET_NOT_FOUND');
  }

  return {
    userId: row.userId,
    available: row.available,
    reserved: row.reserved,
    total: row.available + row.reserved,
  };
}

/**
 * PROJECT.md section 5.9 / 9.9: wallet columns are a cache of the ledger, so a
 * reconciliation job proves `available + reserved == SUM(ledger)`.
 *
 * The ledger is the source of truth, so drift is computed FROM the ledger rather
 * than compared against a stored "expected" value.
 */
export interface ReconcileReport {
  userId: string;
  /** available + reserved as stored on the wallet. */
  walletTotal: number;
  /** SUM(credit_ledger.amount) for the same user. */
  ledgerTotal: number;
  available: number;
  reserved: number;
  ledgerAvailable: number;
  ledgerReserved: number;
  drifted: boolean;
}

export async function reconcileUser(
  tx: CreditTransaction,
  userId: string,
): Promise<ReconcileReport | null> {
  const balance = await getBalance(tx, userId);

  // One grouped query: the ledger is the source of truth, so the split between
  // available and reserved is derived from the entry types, not read back.
  const rows = await tx.execute<{
    entry_type: string;
    total: string;
    count: string;
  }>(sql`
    SELECT entry_type::text AS entry_type,
           SUM(amount)::text AS total,
           COUNT(*)::text AS count
    FROM credit_ledger
    WHERE user_id = ${userId}::uuid
    GROUP BY entry_type
  `);

  let ledgerAvailable = 0;
  let ledgerReserved = 0;

  for (const row of rows.rows) {
    // node-postgres returns bigint SUM as a string; Number() keeps the comparison
    // exact for any balance within safe-integer range.
    const total = Number(row.total);
    switch (row.entry_type) {
      // Grants add to available.
      case 'SIGNUP_BONUS':
      case 'PURCHASE':
      case 'ADJUSTMENT':
        ledgerAvailable += total;
        break;
      // RESERVE is recorded negative: it moved credits out of available.
      case 'RESERVE':
        ledgerAvailable += total;
        break;
      // CAPTURE is recorded negative: reserved credits are spent.
      case 'CAPTURE':
        ledgerReserved += total;
        break;
      // REFUND is recorded positive: reserved credits came back.
      case 'REFUND':
        ledgerReserved += total;
        break;
      // EXPIRY is recorded negative against available.
      case 'EXPIRY':
        ledgerAvailable += total;
        break;
      default:
        throw new CreditError(`Unknown ledger entry type "${row.entry_type}"`, 'INVALID_AMOUNT');
    }
  }

  const walletTotal = balance.available + balance.reserved;
  const ledgerTotal = ledgerAvailable + ledgerReserved;

  return {
    userId,
    available: balance.available,
    reserved: balance.reserved,
    walletTotal,
    ledgerTotal,
    ledgerAvailable,
    ledgerReserved,
    drifted: walletTotal !== ledgerTotal,
  };
}

/** Reconcile every wallet; the hourly job and the admin report both use this. */
export async function reconcileAll(tx: CreditTransaction): Promise<ReconcileReport[]> {
  const all = await tx.select({ userId: wallets.userId }).from(wallets);
  const reports: ReconcileReport[] = [];

  for (const { userId } of all) {
    // A wallet always exists for every user id selected above, so a null report
    // means the row vanished mid-loop; skipping it is the honest handling.
    const report = await reconcileUser(tx, userId);
    if (report !== null) {
      reports.push(report);
    }
  }

  return reports;
}

export type { Database, DbTransaction };
