import type { Prisma, PrismaClient } from '@prisma/client';

import { REFERENCE_TYPES, assertIntegerCredits, type LedgerEntry } from './types';

/** The client handed to a `prisma.$transaction` callback. */
export type TransactionClient = Prisma.TransactionClient;

/**
 * Signup bonus.
 *
 * PROJECT.md section 5.1 rule 1: every new user gets 50 credits, granted once,
 * inside the same transaction that creates the user. AGENTS.md rule 6 repeats
 * that the amount comes from `SIGNUP_BONUS_CREDITS`.
 *
 * Design notes:
 *
 * - The bonus is inserted FIRST and its unique violation is what proves "once".
 *   We catch P2002 on the signup-bonus index and treat it as success, so a
 *   retried registration of the same user is idempotent rather than a 500.
 * - The wallet upsert is a single INSERT ... ON CONFLICT DO UPDATE, so we never
 *   read-then-write a balance (AGENTS.md rule 2).
 * - This function runs inside the caller's transaction (the user-creation one),
 *   so a rollback anywhere removes the user AND the bonus together. A user can
 *   never exist with no bonus, or a bonus with no user.
 */

export interface GrantSignupBonusInput {
  userId: string;
  amount: number;
  /** Recorded on the ledger row for audit; never user input. */
  note?: string;
}

const SIGNUP_BONUS_NOTE = 'Signup bonus';

const UNIQUE_VIOLATION = 'P2002';

/**
 * Transaction-capable client.
 *
 * Accepts either a full `PrismaClient` or the interactive-transaction client a
 * `prisma.$transaction` callback receives. Credit writes must be able to join the
 * caller's transaction (AGENTS.md rule 9), and forcing callers to unwrap a
 * `Prisma.TransactionClient` would push transaction management onto them.
 */
export type CreditTransaction = PrismaClient | TransactionClient;

export async function grantSignupBonus(
  tx: CreditTransaction,
  input: GrantSignupBonusInput,
): Promise<void> {
  const { userId, amount } = input;
  assertIntegerCredits(amount, 'signup bonus');

  // Ledger first: if the bonus already exists we abort before touching the wallet,
  // so a duplicate grant can never inflate `available`.
  try {
    await tx.creditLedger.create({
      data: {
        userId,
        entryType: 'SIGNUP_BONUS',
        amount,
        referenceType: REFERENCE_TYPES.SYSTEM,
        referenceId: null,
        note: input.note ?? SIGNUP_BONUS_NOTE,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already granted (retry of the same registration). Nothing to do.
      return;
    }
    throw error;
  }

  // Ledger row is in place, so apply the matching wallet movement atomically.
  await tx.$executeRaw`
    INSERT INTO wallets (user_id, available, reserved, created_at, updated_at)
    VALUES (${userId}::uuid, ${amount}, 0, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET available = wallets.available + ${amount},
          updated_at = now()
  `;
}

/**
 * Prisma's unique-constraint error code. Narrowed structurally rather than with
 * `any`, per AGENTS.md section 7.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
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

  await tx.creditLedger.create({
    data: {
      userId,
      entryType,
      amount,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      note: input.note ?? null,
    },
    select: { id: true },
  });

  await tx.$executeRaw`
    INSERT INTO wallets (user_id, available, reserved, created_at, updated_at)
    VALUES (${userId}::uuid, ${amount}, 0, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET available = wallets.available + ${amount},
          updated_at = now()
  `;
}

/** Test/seed helper: the ledger rows for a user, newest first. */
export async function listLedger(
  tx: CreditTransaction,
  userId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  return tx.creditLedger.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
