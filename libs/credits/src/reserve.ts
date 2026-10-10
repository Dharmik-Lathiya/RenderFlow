import { and, eq, sql } from 'drizzle-orm';
import { InsufficientCreditsError } from '@renderflow/common';
import type { GenerationKind } from '@renderflow/common';
import { creditLedger, generationJobs, outboxEvents, wallets, type Database } from '@renderflow/db';

import { CreditError, assertIntegerCredits, type CreditTransaction } from './signup-bonus';
import { priceFor } from './pricing';

/**
 * Reserve / capture / refund / adjust.
 *
 * Every balance change in this file is a single guarded `UPDATE ... WHERE`
 * whose affected-row count is the decision. Nothing here reads a balance and
 * then writes one back (AGENTS.md rule 2), because that pattern is what lets two
 * concurrent requests both observe 50 and both spend it.
 *
 * The reservation's atomicity comes from the database, not from application
 * logic: the guarded UPDATE serialises on the wallet row, and the
 * `(reference_type, reference_id, entry_type)` unique index makes each movement
 * at-most-once however many times a worker, a reaper and a client all retry.
 */

export const JOB_REFERENCE_TYPE = 'JOB';

export interface ReserveInput {
  userId: string;
  kind: GenerationKind;
  /**
   * Cost in credits. Omit to look the price up from `pricing_rules`.
   *
   * Never pass a client-supplied number: the only legitimate caller of the
   * explicit form is an internal multi-item reservation (test C11), which
   * computes the total from server-side quotes.
   */
  cost?: number;
  payload?: Record<string, unknown>;
  postId?: string | null;
  maxAttempts?: number;
  /** PROJECT.md section 9.5, test C10. */
  idempotencyKey?: string | null;
  /**
   * The workspace the job belongs to.
   *
   * Required to emit the outbox event, because `job.created` has to name the
   * workspace a worker will act on and the event schema validates it as a uuid.
   * A caller that omits it gets a job with no event, which means nothing will
   * pick it up - so the API path always supplies it, and omitting it is only
   * sensible for a job its own caller will drive directly.
   */
  workspaceId?: string;
  /**
   * Emit the outbox event. Only the caller that owns the transaction should set
   * this; a nested reserve inside someone else's transaction must not publish a
   * second `job.created`.
   */
  emitOutbox?: boolean;
}

export interface Reservation {
  jobId: string;
  cost: number;
  /** The pre-existing job for a replayed idempotency key, if any. */
  replayed: boolean;
}

/**
 * Reserves credits and creates the job, atomically.
 *
 * Runs inside the caller's transaction: a job can never exist without its
 * reservation, and reserved credits can never exist without a job
 * (AGENTS.md rule 9). PROJECT.md section 5.4 lists the same statement order.
 *
 * On insufficient funds the guarded UPDATE matches zero rows, nothing else in
 * the transaction has happened yet, and `402 INSUFFICIENT_CREDITS` is thrown -
 * so no job, no ledger row and no event are created (test C4).
 */
export async function reserve(tx: CreditTransaction, input: ReserveInput): Promise<Reservation> {
  const { userId, kind } = input;
  const cost = input.cost ?? (await priceFor(tx, kind)).credits;

  assertIntegerCredits(cost, 'reservation cost');

  if (input.maxAttempts !== undefined) {
    assertIntegerCredits(input.maxAttempts, 'max attempts');
  }

  // Replay: an idempotency key already used by this user returns the original
  // job without reserving again (test C10). Checked first because it is the
  // cheap path for a legitimate client retry.
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const existing = await findJobByIdempotencyKey(tx, userId, input.idempotencyKey);
    if (existing !== null) {
      return { jobId: existing.id, cost: existing.creditsReserved, replayed: true };
    }
  }

  const jobId = crypto.randomUUID();

  // The guarded UPDATE. `available >= cost` is the whole overdraft protection:
  // under concurrency Postgres re-evaluates the predicate against the row as it
  // locks it, so two callers cannot both pass with the same 50 credits.
  const moved = await tx.execute(sql`
    UPDATE wallets
       SET available = available - ${cost},
           reserved  = reserved  + ${cost},
           updated_at = now()
     WHERE user_id = ${userId}::uuid
       AND available >= ${cost}
  `);

  if (affectedRows(moved) === 0) {
    const balance = await currentBalance(tx, userId);
    throw new InsufficientCreditsError(cost, balance);
  }

  // Ledger first, then the job: if the unique key collides (a concurrent replay
  // that got past the check above) the transaction aborts before the wallet
  // change is visible, and the reserved credits are returned by the rollback.
  await tx.insert(creditLedger).values({
    userId,
    entryType: 'RESERVE',
    amount: -cost,
    referenceType: JOB_REFERENCE_TYPE,
    referenceId: jobId,
    note: `reserve ${kind}`,
  });

  try {
    await tx.insert(generationJobs).values({
      id: jobId,
      userId,
      postId: input.postId ?? null,
      kind,
      status: 'PENDING',
      stage: 'PLAN',
      creditsReserved: cost,
      payload: input.payload ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    });
  } catch (error) {
    // A unique violation here is a concurrent replay of the same key. The
    // transaction will roll back, so the caller's retry finds the real job.
    if (isUniqueViolation(error)) {
      throw new CreditError(
        'A job with this Idempotency-Key already exists.',
        'IDEMPOTENCY_CONFLICT',
      );
    }
    throw error;
  }

  if (input.emitOutbox !== false && input.workspaceId !== undefined) {
    await tx.insert(outboxEvents).values({
      aggregateType: 'JOB',
      aggregateId: jobId,
      eventType: 'job.created',
      dedupeKey: `JOB:${jobId}:job.created`,
      payload: {
        eventType: 'job.created',
        jobId,
        userId,
        workspaceId: input.workspaceId,
        kind,
        creditsReserved: cost,
      },
    });
  }

  return { jobId, cost, replayed: false };
}

/**
 * Idempotent reserve for HTTP handlers.
 *
 * `reserve` on its own is correct but has a rough edge: when a client retries an
 * `Idempotency-Key` concurrently with its own first attempt, the losers do not
 * recognise themselves as replays. They pass the "have I seen this key" lookup
 * (nothing is committed yet), then fail the guarded UPDATE because the winner
 * already moved the credits - so a retry whose original call SUCCEEDED comes back
 * as `402 INSUFFICIENT_CREDITS`. Verified against a real Postgres with 8 racing
 * requests on one key.
 *
 * That is wrong to surface: the caller would see a payment error for work it
 * already paid for. So on failure this re-reads the key afterwards, outside the
 * aborted transaction, and returns the original job if one now exists.
 *
 * The re-read needs a handle that is not the failed transaction - Postgres will
 * not let a transaction that has been aborted run more statements - so this takes
 * the database handle rather than a transaction and owns the transaction itself.
 */
export async function reserveOnce(db: Database, input: ReserveInput): Promise<Reservation> {
  try {
    return await db.transaction((tx) => reserve(tx, input));
  } catch (error) {
    if (input.idempotencyKey === undefined || input.idempotencyKey === null) {
      throw error;
    }

    // A fresh handle: the transaction that just failed cannot be queried.
    const existing = await findJobByIdempotencyKey(db, input.userId, input.idempotencyKey);

    if (existing === null) {
      // Nothing was created by the race, so this really is a genuine failure
      // (most likely insufficient credits) and the caller deserves to hear about
      // it rather than having it swallowed.
      throw error;
    }

    return { jobId: existing.id, cost: existing.creditsReserved, replayed: true };
  }
}

/**
 * Refunds a failed job.
 *
 * Idempotent by construction (tests C7, C8): the job row's `refunded` flag is
 * claimed with a guarded UPDATE, and only the caller that flips zero rows to one
 * may move credits. A reaper and a worker racing on the same job produce one
 * refund between them, not two.
 *
 * A job that has already been captured is refused outright (test C9): the user
 * paid for it, and returning the credits would mint credits from nothing.
 */
export async function refund(
  tx: CreditTransaction,
  jobId: string,
  reason?: string,
): Promise<{ refunded: boolean; amount: number }> {
  // Claim the refund. `refunded = false AND captured = false` means:
  //   - already refunded -> no-op (C8);
  //   - already captured  -> no-op, and the caller is told why (C9).
  const claimed = await tx
    .update(generationJobs)
    .set({ refunded: 1, status: 'FAILED', finishedAt: new Date(), error: reason ?? null })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.refunded, 0),
        eq(generationJobs.captured, 0),
      ),
    )
    .returning({ userId: generationJobs.userId, cost: generationJobs.creditsReserved });

  const job = claimed[0];

  if (job === undefined) {
    // Either already refunded, or captured. Both are "someone else already
    // settled this job", which is a no-op rather than an error: the caller's
    // intent (this job's reservation is settled) already holds.
    return { refunded: false, amount: 0 };
  }

  // Guarded on `reserved >= cost`: a refund can only give back credits that are
  // actually held. Without this a job whose credits were somehow already
  // released would push `available` up for free.
  const moved = await tx.execute(sql`
    UPDATE wallets
       SET reserved  = reserved  - ${job.cost},
           available = available + ${job.cost},
           updated_at = now()
     WHERE user_id = ${job.userId}::uuid
       AND reserved >= ${job.cost}
  `);

  if (affectedRows(moved) === 0) {
    // The claim above succeeded but the wallet disagrees, so the state is
    // inconsistent. Rolling back is the safe outcome: the refund stays
    // unapplied and reconciliation will report the drift rather than this
    // silently inventing credits.
    throw new CreditError(
      `Refund for job ${jobId} cannot be applied: the wallet holds fewer than ${job.cost} reserved credits.`,
      'LEDGER_DRIFT',
    );
  }

  await tx.insert(creditLedger).values({
    userId: job.userId,
    entryType: 'REFUND',
    amount: job.cost,
    referenceType: JOB_REFERENCE_TYPE,
    referenceId: jobId,
    note: reason ?? 'job refunded',
  });

  await tx.insert(outboxEvents).values({
    aggregateType: 'JOB',
    aggregateId: jobId,
    eventType: 'credits.refunded',
    dedupeKey: `JOB:${jobId}:credits.refunded`,
    payload: {
      eventType: 'credits.refunded',
      userId: job.userId,
      jobId,
      amount: job.cost,
    },
  });

  return { refunded: true, amount: job.cost };
}

/**
 * Captures a completed job: the reserved credits are spent.
 *
 * Idempotent for the same reason as `refund`, and mutually exclusive with it -
 * `generation_jobs_not_captured_and_refunded` is a CHECK constraint, so a race
 * that somehow tried both is rejected by the database rather than by timing.
 */
export async function capture(
  tx: CreditTransaction,
  jobId: string,
  result?: Record<string, unknown>,
): Promise<{ captured: boolean; amount: number }> {
  const claimed = await tx
    .update(generationJobs)
    .set({
      captured: 1,
      status: 'COMPLETED',
      finishedAt: new Date(),
      ...(result === undefined ? {} : { result }),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.captured, 0),
        eq(generationJobs.refunded, 0),
      ),
    )
    .returning({ userId: generationJobs.userId, cost: generationJobs.creditsReserved });

  const job = claimed[0];

  if (job === undefined) {
    return { captured: false, amount: 0 };
  }

  const moved = await tx.execute(sql`
    UPDATE wallets
       SET reserved = reserved - ${job.cost},
           updated_at = now()
     WHERE user_id = ${job.userId}::uuid
       AND reserved >= ${job.cost}
  `);

  if (affectedRows(moved) === 0) {
    throw new CreditError(
      `Capture for job ${jobId} cannot be applied: the wallet holds fewer than ${job.cost} reserved credits.`,
      'LEDGER_DRIFT',
    );
  }

  // CAPTURE is recorded negative: the credits left the user's holdings, and the
  // reserved bucket is what shrinks.
  await tx.insert(creditLedger).values({
    userId: job.userId,
    entryType: 'CAPTURE',
    amount: -job.cost,
    referenceType: JOB_REFERENCE_TYPE,
    referenceId: jobId,
    note: 'job captured',
  });

  return { captured: true, amount: job.cost };
}

export interface AdjustInput {
  userId: string;
  /** Signed: positive grants, negative takes. Never zero - use a note-only row. */
  amount: number;
  reason: string;
  actorId?: string | null;
  referenceId?: string | null;
}

/**
 * Manual credit adjustment (admin).
 *
 * The only way to change a balance outside the reserve/capture/refund cycle, and
 * therefore the one an operator could abuse. It requires a reason, records it on
 * the ledger, and the reference id is per-adjustment so repeated adjustments are
 * each their own row rather than colliding on the idempotency key.
 */
export async function adjust(tx: CreditTransaction, input: AdjustInput): Promise<void> {
  const { userId, amount } = input;

  if (!Number.isInteger(amount) || amount === 0) {
    throw new CreditError(
      `Adjustment must be a non-zero integer, received ${amount}`,
      'INVALID_AMOUNT',
    );
  }

  if (input.reason.trim() === '') {
    // An adjustment with no reason is indistinguishable from a bug that touched
    // someone's balance, which is exactly what an audit cannot investigate.
    throw new CreditError('Adjustment requires a reason', 'INVALID_AMOUNT');
  }

  const moved = await tx.execute(sql`
    UPDATE wallets
       SET available = available + ${amount},
           updated_at = now()
     WHERE user_id = ${userId}::uuid
       AND available + ${amount} >= 0
  `);

  if (affectedRows(moved) === 0) {
    const balance = await currentBalance(tx, userId);
    throw new CreditError(
      `Adjustment of ${amount} would take the balance below zero (current: ${balance})`,
      'INVALID_AMOUNT',
    );
  }

  await tx.insert(creditLedger).values({
    userId,
    entryType: 'ADJUSTMENT',
    amount,
    referenceType: 'ADMIN',
    // Distinct per adjustment so the idempotency key does not suppress the
    // second of two legitimate operator actions.
    referenceId: input.referenceId ?? crypto.randomUUID(),
    note:
      input.actorId === undefined || input.actorId === null
        ? input.reason
        : `${input.reason} (by ${input.actorId})`,
  });
}

// --- internals ------------------------------------------------------------

/**
 * Reads the affected-row count from a Drizzle `execute` result.
 *
 * node-postgres reports `rowCount` for UPDATE/DELETE and `rows` for SELECT, and
 * the guard above depends on this number being right, so the absence of a count
 * is treated as a hard error rather than as zero.
 */
function affectedRows(result: { rowCount?: number | null; rows?: unknown[] }): number {
  if (typeof result.rowCount === 'number') {
    return result.rowCount;
  }
  throw new Error('Database driver did not report an affected-row count for a guarded UPDATE');
}

/** Current available balance, for error messages only. Never used to decide. */
async function currentBalance(tx: CreditTransaction, userId: string): Promise<number> {
  const rows = await tx
    .select({ available: wallets.available })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    throw new CreditError(`No wallet for user ${userId}`, 'WALLET_NOT_FOUND');
  }
  return row.available;
}

async function findJobByIdempotencyKey(
  tx: CreditTransaction,
  userId: string,
  key: string,
): Promise<{ id: string; creditsReserved: number } | null> {
  const rows = await tx
    .select({ id: generationJobs.id, creditsReserved: generationJobs.creditsReserved })
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, userId), eq(generationJobs.idempotencyKey, key)))
    .limit(1);

  return rows[0] ?? null;
}

/** Postgres unique_violation, reached through Drizzle's error wrapper. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  let depth = 0;
  while (typeof current === 'object' && current !== null && depth < 5) {
    if ((current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}
