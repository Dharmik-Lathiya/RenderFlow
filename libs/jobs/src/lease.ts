import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { generationJobs, type Database } from '@renderflow/db';

/**
 * Leases (PROJECT.md section 9.2, 9.3; chaos tests R1-R5).
 *
 * A worker that dies mid-render leaves a job that no process is working on and
 * no queue entry will ever arrive for. The reservation stays pinned to the
 * user's balance, and the job sits in `PROCESSING` forever. The lease is what
 * makes that recoverable: a worker holds `locked_until`, renews it while it
 * works, and when it stops renewing - because it crashed - the reaper can tell
 * the difference between "slow" and "gone".
 *
 * Three rules, each of which is a separate guard in the SQL rather than a check
 * in application code:
 *
 *  1. **Acquire is a guarded UPDATE, not a read-then-write.** Two workers racing
 *     for the same job must produce one winner, decided by the database. A
 *     `SELECT` followed by an `UPDATE` would let both believe they won and both
 *     run the stages.
 *
 *  2. **Renewal is guarded on `worker_id`.** A worker that was declared dead,
 *     had its lease taken by someone else, and then woke up must not be able to
 *     extend a lease it no longer holds. Without the guard, the slow-recovering
 *     worker and the new owner would both think they had the job, and the
 *     reaper would never be able to reclaim it again.
 *
 *  3. **Every mutation is a no-op after a terminal state.** `COMPLETED`,
 *     `FAILED` and `CANCELLED` are excluded from every statement here, so a
 *     heartbeat that races a capture cannot resurrect a finished job.
 */

export interface LeaseConfig {
  /** How long a lease is valid for. A worker must renew within this. */
  leaseSeconds: number;
  /** How often a worker renews. Must be comfortably under `leaseSeconds`. */
  heartbeatSeconds: number;
  /** Attempts before the reaper gives up and refunds. */
  maxAttempts: number;
}

export const DEFAULT_LEASE: LeaseConfig = {
  leaseSeconds: 120,
  heartbeatSeconds: 30,
  maxAttempts: 3,
};

/**
 * Fails fast on a configuration that would strand jobs.
 *
 * A heartbeat interval at or above the lease length means the lease can expire
 * *while the worker is still running*, so the reaper would hand a live job to a
 * second worker. That is not a slow environment problem; it is two workers
 * rendering the same reel and racing to capture.
 */
export function validateLeaseConfig(config: LeaseConfig): LeaseConfig {
  if (!Number.isInteger(config.leaseSeconds) || config.leaseSeconds <= 0) {
    throw new Error(`JOB_LEASE_SECONDS must be a positive integer, got ${config.leaseSeconds}`);
  }
  if (!Number.isInteger(config.heartbeatSeconds) || config.heartbeatSeconds <= 0) {
    throw new Error(`HEARTBEAT_SECONDS must be a positive integer, got ${config.heartbeatSeconds}`);
  }
  if (config.heartbeatSeconds * 2 > config.leaseSeconds) {
    throw new Error(
      `HEARTBEAT_SECONDS (${config.heartbeatSeconds}) must be at most half of ` +
        `JOB_LEASE_SECONDS (${config.leaseSeconds}): a worker that misses two ` +
        `heartbeats has to still hold a valid lease.`,
    );
  }
  return config;
}

/**
 * Generated once per module load: stable for the life of the process, different
 * in every other one.
 */
const PROCESS_INSTANCE = randomUUID().slice(0, 8);

/**
 * A stable identity for this process.
 *
 * Stable for the process lifetime and different between processes, which is the
 * whole requirement:
 *
 *  - Unstable *within* a process would break every renewal. `renewLease` is
 *    guarded on `worker_id`, so a worker that computed a fresh id on each call
 *    could never extend its own lease and would abandon the job after its first
 *    heartbeat.
 *  - Not different *between* processes would let two workers on one host share an
 *    id, and the guard would treat the loser as the lease holder.
 *
 * `hostname:pid` covers most of it; the random instance covers the rest, because
 * two containers on one host share both. Pass a suffix only to make an id
 * reproducible in a test.
 */
export function workerIdForProcess(suffix?: string): string {
  return [hostname(), process.pid, suffix ?? PROCESS_INSTANCE].join(':');
}

export interface AcquiredLease {
  jobId: string;
  workerId: string;
  /** Attempts counted on the job row, 1-based. */
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
}

/**
 * Takes the lease on a job, or reports that someone else has it.
 *
 * Returns `null` rather than throwing when the job is already leased by a live
 * worker: that is a normal outcome of two workers being handed the same event,
 * not an error. Throwing would make the loser look broken.
 */
export async function acquireLease(
  db: Database,
  jobId: string,
  workerId: string,
  config: LeaseConfig,
): Promise<AcquiredLease | null> {
  const rows = await db
    .update(generationJobs)
    .set({
      workerId,
      heartbeatAt: new Date(),
      lockedUntil: sql`now() + make_interval(secs => ${config.leaseSeconds})`,
      status: 'PROCESSING',
      // The durable attempt counter. BullMQ's own `attemptsMade` is not enough:
      // it lives in Redis, and a Redis restart - the exact event the reaper
      // exists for - would reset it and give an infinite number of retries.
      attempts: sql`${generationJobs.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        // Terminal states are excluded so a late heartbeat cannot resurrect a
        // completed or refunded job.
        sql`${generationJobs.status} IN ('PENDING','PROCESSING')`,
        // Free if unclaimed, or claimed and now expired.
        or(isNull(generationJobs.lockedUntil), lt(generationJobs.lockedUntil, new Date())),
      ),
    )
    .returning({
      attempts: generationJobs.attempts,
      maxAttempts: generationJobs.maxAttempts,
      lockedUntil: generationJobs.lockedUntil,
    });

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    jobId,
    workerId,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    expiresAt: row.lockedUntil ?? new Date(),
  };
}

/**
 * Extends a lease this worker still holds.
 *
 * Returns false when the lease is gone - taken by another worker, or the job
 * reached a terminal state. The caller must stop working on the job when this
 * returns false; continuing would produce output nobody is waiting for.
 */
export async function renewLease(
  db: Database,
  jobId: string,
  workerId: string,
  config: LeaseConfig,
): Promise<boolean> {
  const rows = await db
    .update(generationJobs)
    .set({
      heartbeatAt: new Date(),
      lockedUntil: sql`now() + make_interval(secs => ${config.leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        // The guard that makes rule 2 real: only the current holder renews.
        eq(generationJobs.workerId, workerId),
        sql`${generationJobs.status} IN ('PENDING','PROCESSING')`,
      ),
    )
    .returning({ id: generationJobs.id });

  return rows.length > 0;
}

/**
 * Gives the job up without finishing it.
 *
 * Used on SIGTERM and whenever a worker declines the job. Clearing the lease
 * rather than waiting for it to expire is what makes shutdown fast: the reaper
 * would otherwise idle for a whole lease period before anyone could pick the job
 * up, and a rolling deploy would stall every in-flight generation.
 */
export async function releaseLease(
  db: Database,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await db
    .update(generationJobs)
    .set({ workerId: null, lockedUntil: null, updatedAt: new Date() })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.workerId, workerId)))
    .returning({ id: generationJobs.id });

  return rows.length > 0;
}

/**
 * A heartbeat loop that stops as soon as the lease is lost.
 *
 * The important behaviour is the *stopping*. If renewal fails the loop resolves
 * and sets `lost`, because a worker whose lease has been reclaimed is no longer
 * the owner of the job: continuing would mean two workers rendering the same
 * reel, and the loser would race the winner to capture the credits.
 */
export interface HeartbeatHandle {
  /** True once the lease could not be renewed. Sticky. */
  readonly lost: boolean;
  stop: () => void;
  /** Resolves when the loop stops, so a drain can await it. */
  done: Promise<void>;
}

export function startHeartbeat(
  db: Database,
  jobId: string,
  workerId: string,
  config: LeaseConfig,
): HeartbeatHandle {
  let lost = false;
  let stopped = false;
  /** Settles the pending sleep, so `stop()` does not have to wait it out. */
  let wake: (() => void) | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const handle: HeartbeatHandle = {
    get lost() {
      return lost;
    },
    stop: () => {
      stopped = true;
      // The pending sleep is RESOLVED, not just cleared. `clearTimeout` alone
      // leaves the loop awaiting a promise nothing will ever settle, so `done`
      // never resolves - and every caller that awaits it hangs. The worker's
      // SIGTERM drain awaits it, so that is a worker that ignores shutdown until
      // something kills it.
      wake?.();
    },
    done: Promise.resolve(),
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await sleep(config.heartbeatSeconds * 1000);

      if (stopped) {
        return;
      }

      try {
        lost = !(await renewLease(db, jobId, workerId, config));
      } catch {
        // A database blip is not proof the lease is gone. Treating it as a loss
        // would abandon every in-flight job on a momentary hiccup; treating it as
        // success is the safe direction, because the lease expires on its own if
        // the database really is unavailable.
        continue;
      }

      if (lost) {
        return;
      }
    }
  };

  handle.done = loop();

  return handle;
}

/**
 * Jobs the reaper should look at: unfinished, and either never claimed or
 * claimed long enough ago that the holder is presumed gone.
 */
export interface ExpiredJob {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  refunded: number;
  captured: number;
}

export async function findExpiredJobs(db: Database, limit = 50): Promise<ExpiredJob[]> {
  return db
    .select({
      id: generationJobs.id,
      status: generationJobs.status,
      attempts: generationJobs.attempts,
      maxAttempts: generationJobs.maxAttempts,
      refunded: generationJobs.refunded,
      captured: generationJobs.captured,
    })
    .from(generationJobs)
    .where(
      and(
        sql`${generationJobs.status} IN ('PENDING','PROCESSING')`,
        or(isNull(generationJobs.lockedUntil), lt(generationJobs.lockedUntil, new Date())),
      ),
    )
    .limit(limit);
}
