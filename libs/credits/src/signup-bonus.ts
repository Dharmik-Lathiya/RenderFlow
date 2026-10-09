import { eq, sql } from 'drizzle-orm';

import { CREDIT_ENTRY_TYPES, type CreditEntryType } from '@renderflow/common';
import { creditLedger, type Database, type DbTransaction } from '@renderflow/db';

/**
 * Signup bonus.
 *
 * PROJECT.md section 5.1 rule 1: every new user gets 50 credits, granted once,
 * inside the same transaction that creates the user. AGENTS.md rule 6 repeats
 * that the amount comes from `SIGNUP_BONUS_CREDITS`.
 *
 * Design notes:
 *
 * - The bonus row is inserted FIRST and its unique violation is what proves
 *   "once". The violation aborts the statement before the wallet is touched, so
 *   a duplicate grant can never inflate `available`.
 * - The wallet upsert is a single INSERT ... ON CONFLICT DO UPDATE, so a balance
 *   is never read-then-written in application code (AGENTS.md rule 2).
 * - This runs inside the caller's transaction, so a rollback anywhere removes
 *   the user AND the bonus together. A user can never exist with no bonus.
 */

/**
 * Transaction-capable handle.
 *
 * Accepts a full `Database` or the transaction-scoped handle from
 * `db.transaction()`, because a credit write must be able to join the caller's
 * transaction (AGENTS.md rule 9).
 */
export type CreditTransaction = Database | DbTransaction;

export interface GrantSignupBonusInput {
  userId: string;
  amount: number;
  /** Recorded on the ledger row for audit; never user input. */
  note?: string;
}

const SIGNUP_BONUS_NOTE = 'Signup bonus';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Prisma's unique-constraint error code.
 *
 * Retained because callers in apps/api map it to EMAIL_ALREADY_REGISTERED, and
 * because keeping the predicate here means one place defines "this was a
 * duplicate" rather than each call site guessing.
 */
const LEGACY_UNIQUE_CODE = 'P2002';

/**
 * Structural check for a unique violation, covering both drivers: node-postgres
 * surfaces the SQLSTATE (`23505`), while the previous Prisma client surfaced a
 * `code` of `P2002`.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === UNIQUE_VIOLATION || code === LEGACY_UNIQUE_CODE) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isUniqueViolation(cause);
}

export async function grantSignupBonus(
  tx: CreditTransaction,
  input: GrantSignupBonusInput,
): Promise<void> {
  const { userId, amount } = input;
  assertIntegerCredits(amount, 'signup bonus');

  // Ledger first: if the bonus already exists we abort before touching the wallet.
  try {
    await tx.insert(creditLedger).values({
      userId,
      entryType: 'SIGNUP_BONUS',
      amount,
      referenceType: 'SYSTEM',
      referenceId: null,
      note: input.note ?? SIGNUP_BONUS_NOTE,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already granted (a retried registration). Nothing to do.
      return;
    }
    throw error;
  }

  // Ledger row is in place, so apply the matching wallet movement atomically.
  // `updated_at` is set explicitly because raw SQL bypasses the schema's
  // `$onUpdate` hook.
  await tx.execute(sql`
    INSERT INTO wallets (user_id, available, reserved, created_at, updated_at)
    VALUES (${userId}::uuid, ${amount}, 0, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET available = wallets.available + ${amount},
          updated_at = now()
  `);
}

/**
 * Adds credits outside the signup path (admin adjustment, test top-up).
 * Append-only: the ledger row is the record, the wallet is the cache.
 */
export async function addCredits(
  tx: CreditTransaction,
  input: {
    userId: string;
    amount: number;
    entryType: 'PURCHASE' | 'ADJUSTMENT';
    referenceType?: string;
    referenceId?: string;
    note?: string;
  },
): Promise<void> {
  const { userId, amount, entryType } = input;
  assertIntegerCredits(amount, 'credit amount');

  await tx.insert(creditLedger).values({
    userId,
    entryType,
    amount,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    note: input.note ?? null,
  });

  await tx.execute(sql`
    INSERT INTO wallets (user_id, available, reserved, created_at, updated_at)
    VALUES (${userId}::uuid, ${amount}, 0, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET available = wallets.available + ${amount},
          updated_at = now()
  `);
}

/** Test/seed helper: the ledger rows for a user, newest first. */
export async function listLedger(
  tx: CreditTransaction,
  userId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const rows = await tx
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(sql`${creditLedger.createdAt} DESC`)
    .limit(limit);

  return rows;
}

/** Reference kinds used in the `(reference_type, reference_id, entry_type)` key. */
export const REFERENCE_TYPES = {
  SYSTEM: 'SYSTEM',
  JOB: 'JOB',
  PURCHASE: 'PURCHASE',
  ADMIN: 'ADMIN',
} as const;

export type ReferenceType = (typeof REFERENCE_TYPES)[keyof typeof REFERENCE_TYPES];

export interface LedgerEntry {
  id: string;
  userId: string;
  entryType: CreditEntryType;
  amount: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  createdAt: Date;
}

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'WALLET_NOT_FOUND'
      | 'INVALID_AMOUNT'
      | 'UNKNOWN_ACTION'
      | 'PRICING_UNAVAILABLE'
      // A refund or capture that cannot be applied because the wallet disagrees
      // with the job. That is corruption rather than a bad request, and it has to
      // be distinguishable so reconciliation alerts on it.
      | 'LEDGER_DRIFT'
      | 'IDEMPOTENCY_CONFLICT',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CreditError';
  }
}

/**
 * Credits are integers. Rejecting non-integers at the boundary is what keeps
 * `SUM(ledger) == available + reserved` exact rather than approximately true.
 */
export function assertIntegerCredits(amount: number, label = 'amount'): void {
  if (!Number.isInteger(amount)) {
    throw new CreditError(`${label} must be an integer, received ${amount}`, 'INVALID_AMOUNT');
  }
  if (amount < 0) {
    throw new CreditError(`${label} must not be negative, received ${amount}`, 'INVALID_AMOUNT');
  }
  if (!Number.isSafeInteger(amount)) {
    throw new CreditError(`${label} exceeds the safe integer range`, 'INVALID_AMOUNT');
  }
}

/** Signup bonus amount from config. Never a literal in logic (AGENTS.md rule 6). */
export function signupBonusCredits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SIGNUP_BONUS_CREDITS;
  if (raw === undefined || raw.trim() === '') {
    // Fail loudly: silently granting 0 would look like a bug in the credit engine.
    throw new CreditError('SIGNUP_BONUS_CREDITS is not configured', 'INVALID_AMOUNT');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CreditError(
      `SIGNUP_BONUS_CREDITS must be a non-negative integer, received "${raw}"`,
      'INVALID_AMOUNT',
    );
  }
  return value;
}

export { CREDIT_ENTRY_TYPES };
export type { CreditEntryType };
