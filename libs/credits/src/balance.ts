import type { CreditTransaction } from './signup-bonus';

import { CreditError, type WalletBalance } from './types';

/**
 * Wallet reads.
 *
 * Read-only: no mutation of `wallets` or `credit_ledger` happens here
 * (AGENTS.md rule 1). `libs/credits` is the only module allowed to write those
 * tables, and this file is deliberately on the safe side of that line.
 */

export async function getBalance(tx: CreditTransaction, userId: string): Promise<WalletBalance> {
  const wallet = await tx.wallet.findUnique({
    where: { userId },
    select: { userId: true, available: true, reserved: true },
  });

  if (wallet === null) {
    throw new CreditError(`No wallet for user ${userId}`, 'WALLET_NOT_FOUND');
  }

  return {
    userId: wallet.userId,
    available: wallet.available,
    reserved: wallet.reserved,
    total: wallet.available + wallet.reserved,
  };
}

/**
 * PROJECT.md section 5.9 / section 9.9: wallet columns are a cache of the
 * ledger, so an hourly job proves `available + reserved == SUM(ledger)`.
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

  // One grouped query: SUM(amount) is the net position, and RESERVE/CAPTURE/REFUND
  // are resolved from the individual entry types rather than re-derived.
  const rows = await tx.$queryRaw<
    Array<{
      entry_type: string;
      total: bigint;
      count: bigint;
    }>
  >`
    SELECT entry_type::text AS entry_type,
           SUM(amount)::bigint AS total,
           COUNT(*)::bigint AS count
    FROM credit_ledger
    WHERE user_id = ${userId}::uuid
    GROUP BY entry_type
  `;

  let ledgerAvailable = 0;
  let ledgerReserved = 0;

  for (const row of rows) {
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
  const userIds = await tx.wallet.findMany({ select: { userId: true } });
  const reports: ReconcileReport[] = [];

  for (const { userId } of userIds) {
    const report = await reconcileUser(tx, userId);
    if (report !== null) {
      reports.push(report);
    }
  }

  return reports;
}
