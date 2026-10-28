import { sql } from 'drizzle-orm';

import { creditLedger } from '@renderflow/db';

import { CreditError, assertIntegerCredits, type CreditTransaction } from './signup-bonus';

/**
 * Crediting a purchase (PROJECT.md section 5.3: `PURCHASE`).
 *
 * The ledger row is written FIRST and the unique index on
 * `(reference_type, reference_id, entry_type)` is the claim. That ordering is what
 * makes a retried webhook safe: a duplicate insert does nothing, so the balance
 * update below never runs twice. The alternative - credit then record - is how a
 * provider retry doubles somebody's balance.
 *
 * No payment provider is wired to this yet. The function exists because the
 * ledger path is the part that must be right, and because a provider adapter
 * should be an SDK call plus a `referenceId`, not a second implementation of
 * credits.
 */
export interface PurchaseInput {
  userId: string;
  /** Positive integer. Credits bought, not currency. */
  credits: number;
  /**
   * The provider's order id. This is the idempotency key: the same order can be
   * delivered any number of times and credits the wallet once.
   */
  referenceId: string;
  /** `stripe`, `razorpay`, or `stub` during development. */
  provider: string;
  note?: string;
}

export interface PurchaseResult {
  /** False when this reference had already been applied. */
  applied: boolean;
}

export async function purchase(
  tx: CreditTransaction,
  input: PurchaseInput,
): Promise<PurchaseResult> {
  assertIntegerCredits(input.credits, 'credits');

  if (input.credits === 0) {
    throw new CreditError('A purchase must credit at least one credit', 'INVALID_AMOUNT');
  }

  const referenceId = input.referenceId.trim();
  if (referenceId === '') {
    throw new CreditError('A purchase needs a provider reference id', 'INVALID_AMOUNT');
  }

  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      entryType: 'PURCHASE',
      amount: input.credits,
      referenceType: 'PURCHASE',
      referenceId,
      note: input.note ?? `purchase via ${input.provider}`,
    })
    // Partial unique index covers (reference_type, reference_id, entry_type).
    .onConflictDoNothing({
      target: [creditLedger.referenceType, creditLedger.referenceId, creditLedger.entryType],
    })
    .returning({ id: creditLedger.id });

  if (inserted.length === 0) {
    // Already applied. Not an error: a provider retry is the expected cause.
    return { applied: false };
  }

  const updated = await tx.execute(sql`
    UPDATE wallets
       SET available = available + ${input.credits},
           updated_at = now()
     WHERE user_id = ${input.userId}::uuid
  `);

  const affected = (updated as { rowCount?: number | null }).rowCount;

  if (typeof affected !== 'number') {
    throw new Error('Database driver did not report an affected-row count for a purchase');
  }

  if (affected === 0) {
    // The ledger row exists and the wallet does not. Rolling back keeps the
    // inconsistency out of the ledger and visible to reconciliation.
    throw new CreditError(`No wallet for user ${input.userId}`, 'WALLET_NOT_FOUND');
  }

  return { applied: true };
}
