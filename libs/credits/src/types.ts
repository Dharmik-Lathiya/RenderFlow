import { CREDIT_ENTRY_TYPES, type CreditEntryType } from '@renderflow/common';

/**
 * Credit configuration and the row shapes libs/credits accepts.
 *
 * The signup bonus is read from `SIGNUP_BONUS_CREDITS`, never hardcoded
 * (AGENTS.md rule 6). Pricing is read from the `pricing_rules` table, never
 * hardcoded and never accepted from a client (AGENTS.md rule 7).
 */

/** Must match the `entry_type` values of the `credit_ledger` enum. */
export const LEDGER_ENTRY_TYPES = CREDIT_ENTRY_TYPES;

export type LedgerEntryType = CreditEntryType;

/**
 * Reference kinds used in the `(reference_type, reference_id, entry_type)`
 * idempotency key. `SYSTEM` entries have no reference: the partial unique index
 * on `user_id WHERE entry_type = 'SIGNUP_BONUS'` makes them unique per user.
 */
export const REFERENCE_TYPES = {
  SYSTEM: 'SYSTEM',
  JOB: 'JOB',
  PURCHASE: 'PURCHASE',
  ADMIN: 'ADMIN',
} as const;

export type ReferenceType = (typeof REFERENCE_TYPES)[keyof typeof REFERENCE_TYPES];

export interface WalletBalance {
  userId: string;
  available: number;
  reserved: number;
  /** available + reserved: the user's total credit position. */
  total: number;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  entryType: LedgerEntryType;
  amount: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code: 'WALLET_NOT_FOUND' | 'INVALID_AMOUNT' | 'UNKNOWN_ACTION' | 'PRICING_UNAVAILABLE',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CreditError';
  }
}

/**
 * Credits are integers. Rejecting non-integers at the boundary is what keeps
 * `SUM(ledger) == available + reserved` exact instead of approximately true.
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

/** Signup bonus amount from config. Never a literal in logic. */
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
