import { jobCreatedEventSchema } from '@renderflow/common';
import { ProviderError } from '@renderflow/ai';

import { describeError, failJob, runJob, type JobRunDeps } from './runner';

/**
 * The BullMQ processor for a `job.created` event.
 *
 * This is where the retry policy and the refund policy meet, and getting the
 * order of those two wrong is the expensive mistake:
 *
 *  - Refunding on the FIRST failure throws away the user's credits for a blip.
 *    A `TRANSIENT` provider error is retried with the queue's backoff preset and
 *    only the LAST attempt gives the credits back.
 *  - NEVER refunding at all leaves a reservation pinned forever if the worker
 *    process dies with the job mid-flight. That is what Phase 5's reaper is for.
 *
 * So the rule is: refund when retrying cannot help - a `PERMANENT` provider
 * error, or the final attempt - and rethrow so BullMQ still owns the retry.
 *
 * The shape is deliberately a plain function over a minimal job interface rather
 * than a `Processor` type. That is what makes this file unit-testable without a
 * Redis: the retry arithmetic is the part worth testing, and it is pure.
 */

/**
 * The retry counter, split out from the payload.
 *
 * `isFinalAttempt` is about attempt arithmetic and nothing else, so it does not
 * take a payload. That is what lets the arithmetic be tested without constructing
 * a whole job - and it stops the two concerns being tangled later.
 */
export interface AttemptCounter {
  /** Attempts already made, excluding the one in flight. */
  attemptsMade: number;
  /** Total attempts configured for the job, including the first. */
  attempts?: number | undefined;
}

/** The slice of a BullMQ job this handler reads. */
export interface GenerationJobLike extends AttemptCounter {
  data: unknown;
}

export interface GenerationProcessorDeps extends JobRunDeps {
  /** Total attempts to assume when the queue did not say (default 1). */
  defaultAttempts?: number;
}

/**
 * True when this failure should end the job rather than be retried.
 *
 * Exported because the arithmetic is worth stating on its own: `attemptsMade` is
 * 0 on the first attempt, so the last attempt is `attempts - 1`.
 */
export function isFinalAttempt(job: AttemptCounter, defaultAttempts = 1): boolean {
  const attempts = job.attempts ?? defaultAttempts;
  return job.attemptsMade + 1 >= attempts;
}

/** A permanent failure will not improve, so retrying only delays the refund. */
export function isPermanent(error: unknown): boolean {
  return error instanceof ProviderError && error.classification === 'PERMANENT';
}

/**
 * Validates a queue payload before anything else happens to it.
 *
 * Exported separately from the handler so the validation is testable without a
 * database - and it matters enough to test on its own: this is the only place a
 * serialised payload crossing a process boundary is read, and a payload that
 * fails here must not turn into a database lookup for `undefined`.
 */
export function parseGenerationJob(data: unknown): { jobId: string } {
  return jobCreatedEventSchema.parse(data);
}

export async function handleGenerationJob(
  deps: GenerationProcessorDeps,
  job: GenerationJobLike,
): Promise<void> {
  const event = parseGenerationJob(job.data);

  try {
    await runJob(deps, event.jobId);
  } catch (error) {
    if (isPermanent(error) || isFinalAttempt(job, deps.defaultAttempts)) {
      // Idempotent in libs/credits, so a reaper racing us here produces one
      // refund between the two of them rather than two.
      await failJob(deps.db, event.jobId, describeError(error));
    }

    // Rethrown either way: BullMQ owns the retry, and it needs to see the
    // failure to move the job to the DLQ when attempts run out. Swallowing it
    // would mark a failed generation as succeeded.
    throw error;
  }
}

/** A `Processor` for `createWorker`. Wraps the handler with BullMQ's signature. */
export function createGenerationProcessor(
  deps: GenerationProcessorDeps,
): (job: GenerationJobLike) => Promise<void> {
  return (job) => handleGenerationJob(deps, job);
}
