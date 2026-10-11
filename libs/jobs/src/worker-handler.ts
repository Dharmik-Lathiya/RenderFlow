import { eq } from 'drizzle-orm';

import { jobCreatedEventSchema } from '@renderflow/common';
import { ProviderError } from '@renderflow/ai';
import { generationJobs } from '@renderflow/db';

import { startHeartbeat } from './lease';
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

  // The heartbeat is the reason a killed worker is recoverable, so it has to run
  // for the WHOLE invocation including the refund - a worker that hangs during
  // cleanup is exactly as dead as one that hangs mid-render.
  const heartbeat =
    deps.lease === undefined
      ? null
      : startHeartbeat(deps.db, event.jobId, deps.lease.workerId, deps.lease.config);

  try {
    await runJob(deps, event.jobId);
  } catch (error) {
    if (isPermanent(error) || (await outOfAttempts(deps, job, event.jobId))) {
      // Idempotent in libs/credits, so a reaper racing us here produces one
      // refund between the two of them rather than two.
      await failJob(deps.db, event.jobId, describeError(error));
    }

    // Rethrown either way: BullMQ owns the retry, and it needs to see the
    // failure to move the job to the DLQ when attempts run out. Swallowing it
    // would mark a failed generation as succeeded.
    throw error;
  } finally {
    heartbeat?.stop();
    // `done` resolves once the loop has actually exited, so a drain does not
    // close the database pool out from under an in-flight heartbeat.
    await heartbeat?.done;
  }
}

/**
 * Whether the job has spent its attempt budget, and therefore should refund.
 *
 * Which counter answers that depends on how the worker is running:
 *
 *  - **With a lease**, the durable row is authoritative. `runJob` increments it
 *    when it takes the lease, and it survives the Redis restart the reaper
 *    exists for. BullMQ's `attemptsMade` lives in Redis and is reset by exactly
 *    that restart, so trusting it means a queue that loses its state hands every
 *    job an infinite number of retries and never refunds.
 *
 *  - **Without a lease** - tests, and the single-process local run - nothing
 *    advanced the row's counter, so reading it would conclude "budget remains"
 *    forever and a job would never be refunded. The queue's counter is then the
 *    only one that has moved, so it is used.
 */
async function outOfAttempts(
  deps: GenerationProcessorDeps,
  job: GenerationJobLike,
  jobId: string,
): Promise<boolean> {
  if (deps.lease === undefined) {
    return isFinalAttempt(job, deps.defaultAttempts ?? 1);
  }

  const rows = await deps.db
    .select({ attempts: generationJobs.attempts, maxAttempts: generationJobs.maxAttempts })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  const row = rows[0];
  // The job was deleted underneath the worker. Refunding is then moot but safe:
  // `refund` is idempotent and will find nothing to move.
  if (row === undefined) {
    return true;
  }

  // ONLY the row's own budget. `defaultAttempts` describes the queue, and
  // comparing the durable counter against it would let a queue configured for a
  // single attempt shorten a job's real three-attempt budget - so a single
  // transient blip would refund a job that still had two retries left.
  return row.attempts >= row.maxAttempts;
}

/** A `Processor` for `createWorker`. Wraps the handler with BullMQ's signature. */
export function createGenerationProcessor(
  deps: GenerationProcessorDeps,
): (job: GenerationJobLike) => Promise<void> {
  return (job) => handleGenerationJob(deps, job);
}
