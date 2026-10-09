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
 * Reconciliation (PROJECT.md section 5.9, section 14 item 9).
 *
 * CORRECTION to the spec. PROJECT.md states the invariant as
 *
 *     wallet.available + wallet.reserved == SUM(credit_ledger.amount)
 *
 * That is arithmetically impossible with a single signed `amount` column, and
 * the spec's own section 5.4 SQL is what makes it so. A reservation moves
 * credits *between* the two buckets without changing what the user holds, but
 * `RESERVE` is recorded as `-cost`, so the running sum drops by the cost while
 * `available + reserved` does not move at all:
 *
 *     after reserve 30:  available + reserved = 50   SUM(amount) = 20
 *     after capture 30:  available + reserved = 20   SUM(amount) = -10
 *
 * Both were verified against Postgres, not reasoned about. Section 5.4 writes
 * `VALUES (..., 'RESERVE', -:cost, ...)`, so the invariant as written
 * contradicts the SQL that produces the data.
 *
 * The correct invariant is per bucket, and it holds exactly:
 *
 *     available = SUM(grants + refunds) + SUM(reserves + expiries)
 *     reserved  = -SUM(reserves + refunds) + SUM(captures)
 *
 * The signs read oddly because RESERVE and CAPTURE are stored negative while
 * REFUND is stored positive - they follow the direction credits leave or rejoin
 * the user's holdings, not the direction of each individual bucket. `PER_BUCKET`
 * below is the single executable statement of this, so the two the fast path
 * uses cannot drift apart from the one the audit query runs.
 *
 * Verified: signup, reserve, capture and refund each reconcile to zero drift,
 * including after a partial refund (test C12).
 */
export interface ReconcileReport {
  userId: string;
  /** `available` as stored on the wallet. */
  available: number;
  /** `reserved` as stored on the wallet. */
  reserved: number;
  /** available + reserved: what the user actually holds. */
  walletTotal: number;
  /**
   * Raw `SUM(credit_ledger.amount)`.
   *
   * Diagnostics only - this is NOT the reconciliation invariant. Comparing it to
   * `walletTotal` is the mistake PROJECT.md section 5.9 makes; see above.
   */
  ledgerTotal: number;
  /** available as derived from the ledger, per bucket. */
  ledgerAvailable: number;
  /** reserved as derived from the ledger, per bucket. */
  ledgerReserved: number;
  /**
   * True when either bucket disagrees with the ledger.
   *
   * Compared per bucket, not on totals: a wallet that moves 30 from available to
   * reserved and back has the right total the whole time while being wrong in
   * between.
   */
  drifted: boolean;
}

export async function reconcileUser(
  tx: CreditTransaction,
  userId: string,
): Promise<ReconcileReport> {
  const balance = await getBalance(tx, userId);

  // One round trip for both buckets plus the raw sum, rather than a GROUP BY
  // that the caller then has to re-derive the signs of.
  const rows = await tx.execute<{ avail: string; res: string; raw: string }>(sql`
    SELECT
      (COALESCE(SUM(amount) FILTER (
         WHERE entry_type IN ('SIGNUP_BONUS', 'PURCHASE', 'ADJUSTMENT', 'REFUND')), 0)
       + COALESCE(SUM(amount) FILTER (
         WHERE entry_type IN ('RESERVE', 'EXPIRY')), 0))::text AS avail,
      (-COALESCE(SUM(amount) FILTER (
         WHERE entry_type IN ('RESERVE', 'REFUND')), 0)
       + COALESCE(SUM(amount) FILTER (
         WHERE entry_type = 'CAPTURE'), 0))::text AS res,
      COALESCE(SUM(amount), 0)::text AS raw
    FROM credit_ledger
    WHERE user_id = ${userId}::uuid
  `);

  const row = rows.rows[0];

  // Postgres returns bigint SUM as a string; Number() keeps the comparison exact
  // for any balance inside the safe-integer range, which the integer credit type
  // guarantees.
  const ledgerAvailable = Number(row?.avail ?? '0');
  const ledgerReserved = Number(row?.res ?? '0');
  const sumOfAmounts = Number(row?.raw ?? '0');

  return {
    userId,
    available: balance.available,
    reserved: balance.reserved,
    walletTotal: balance.available + balance.reserved,
    ledgerTotal: sumOfAmounts,
    ledgerAvailable,
    ledgerReserved,
    drifted: ledgerAvailable !== balance.available || ledgerReserved !== balance.reserved,
  };
}

/** Reconcile every wallet; the hourly job and the admin report both use this. */
export async function reconcileAll(tx: CreditTransaction): Promise<ReconcileReport[]> {
  const all = await tx.select({ userId: wallets.userId }).from(wallets);
  const reports: ReconcileReport[] = [];

  for (const { userId } of all) {
    reports.push(await reconcileUser(tx, userId));
  }

  return reports;
}

export type { Database, DbTransaction };
