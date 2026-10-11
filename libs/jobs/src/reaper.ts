import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { generationJobs, outboxEvents, type Database } from '@renderflow/db';

import { DEFAULT_LEASE, findExpiredJobs, type LeaseConfig } from './lease';
import { failJob } from './runner';

/**
 * The reaper (PROJECT.md section 9.3, chaos tests R1-R5).
 *
 * This process is why "kill a worker mid-render" is a recoverable event rather
 * than a stuck job with a reservation pinned to a user's balance. Every sweep
 * is a *decision*, and the decisions are mutually exclusive on purpose:
 *
 *   - lease expired, attempts left   -> re-enqueue, and the next worker resumes
 *                                        from the checkpoints it already has
 *   - lease expired, attempts gone    -> FAILED and refund, exactly once
 *   - never started, nothing claimed  -> re-enqueue so the job is not stranded
 *
 * Refund is last and is idempotent through `libs/credits`, so the reaper racing
 * a worker that was actually alive produces one refund between them rather than
 * two. That race is unavoidable and is why the refund cannot be "checked then
 * applied" in application code - the guarded UPDATE inside `refund` is the only
 * place the decision is made.
 *
 * The reaper never *runs* a job. It hands work back to the queue and lets a
 * worker own it, because a reaper that renders reels would need the same lease
 * logic it exists to police.
 */

export interface SweepResult {
  /** Jobs handed back to the queue to be resumed. */
  requeued: string[];
  /** Jobs given up on and refunded. */
  failed: string[];
  /** Rows examined, whether or not anything was done. */
  examined: number;
}

export interface ReaperOptions {
  /** Rows to examine per sweep. */
  batchSize?: number;
  /** Attempts a job gets before it is given up on. Falls back to the row. */
  maxAttempts?: number;
}

/**
 * Publishes a re-enqueue as an outbox event rather than pushing to a queue.
 *
 * Same rule as every other path into the queue (AGENTS.md rule 6): the decision
 * and the request to act on it are one transaction, so a crash between them
 * cannot leave a job that nobody will ever pick up again.
 */
async function requeue(db: Database, jobId: string, reason: string): Promise<boolean> {
  const claimed = await db.transaction(async (tx) => {
    // Guarded: only a job that is unfinished AND whose lease is still free or
    // still expired can be re-enqueued.
    //
    // Re-checking expiry here, rather than trusting the sweep's earlier read, is
    // what closes the window between them. A worker that acquired the lease in
    // between would otherwise be overwritten - the reaper and the live worker
    // both believing they own the job.
    //
    // The first version of this guard was `locked_until IS NULL`, which is
    // strictly wrong: the sweep found the job *because* its lease had expired,
    // and then the requeue refused it for having a non-null lease. It passed the
    // "never started" test and failed every reclaim.
    const rows = await tx
      .update(generationJobs)
      .set({
        status: 'PENDING',
        workerId: null,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(
        sql`${generationJobs.id} = ${jobId}::uuid
             AND ${generationJobs.status} IN ('PENDING','PROCESSING')
             AND (${generationJobs.lockedUntil} IS NULL
                  OR ${generationJobs.lockedUntil} < now())`,
      )
      .returning({ id: generationJobs.id });

    if (rows.length === 0) {
      return false;
    }

    await tx.insert(outboxEvents).values({
      aggregateType: 'JOB',
      aggregateId: jobId,
      eventType: 'job.created',
      // Distinct from the original create event, so the dedupe key does not
      // collide with it and the relay really does publish a second message.
      dedupeKey: `JOB:${jobId}:job.requeued:${randomUUID()}`,
      payload: {
        eventType: 'job.created',
        jobId,
        reason,
      },
    });

    return true;
  });

  return claimed;
}

/**
 * One pass over the expired jobs.
 *
 * Split from the loop for the same reason as the outbox relay: the decision is
 * worth testing without a timer, and `sweepOnce` is what a test drives.
 */
export async function sweepOnce(db: Database, options: ReaperOptions = {}): Promise<SweepResult> {
  const batchSize = options.batchSize ?? 50;
  const expired = await findExpiredJobs(db, batchSize);

  const requeued: string[] = [];
  const failed: string[] = [];

  for (const job of expired) {
    // A job that was never claimed is not "expired" in any meaningful sense -
    // it is a job whose event the relay has not delivered yet. Re-queueing it is
    // right, and it is the case that has no attempt budget: the job has not
    // started, so this is not a failed generation.
    if (job.attempts === 0) {
      if (await requeue(db, job.id, 'never started')) {
        requeued.push(job.id);
      }
      continue;
    }

    const limit = options.maxAttempts ?? job.maxAttempts;

    if (job.attempts < limit) {
      if (await requeue(db, job.id, `lease expired after ${job.attempts} attempt(s)`)) {
        requeued.push(job.id);
      }
      continue;
    }

    // Out of attempts. `failJob` is idempotent in libs/credits, so if a worker
    // was in fact still alive and got there first, this returns
    // `{ refunded: false }` and moves nothing.
    const outcome = await failJob(
      db,
      job.id,
      `no worker held the lease and ${job.attempts} attempt(s) were used`,
    );

    if (outcome.refunded) {
      failed.push(job.id);
    }
  }

  return { requeued, failed, examined: expired.length };
}

/**
 * Jobs that have been sitting in `PENDING` with no queue entry.
 *
 * Separate from the lease sweep because they have a different cause. A PENDING
 * job with an expired lease is usually a worker that died; a PENDING job that has
 * never been leased at all is usually an event the relay never published -
 * Redis was down when it should have been, or the process died between the two
 * writes. `sweepOnce` covers the second case too (attempts === 0), but this
 * sweep is what finds them when the queue is empty and nothing else is broken.
 */
export async function sweepOrphanedPending(
  db: Database,
  olderThanSeconds: number,
  batchSize = 50,
): Promise<SweepResult> {
  const rows = await db
    .select({
      id: generationJobs.id,
      attempts: generationJobs.attempts,
      maxAttempts: generationJobs.maxAttempts,
    })
    .from(generationJobs)
    .where(
      sql`${generationJobs.status} = 'PENDING'
           AND ${generationJobs.attempts} = 0
           AND ${generationJobs.workerId} IS NULL
           AND ${generationJobs.createdAt} < now() - make_interval(secs => ${olderThanSeconds})`,
    )
    .limit(batchSize);

  const requeued: string[] = [];

  for (const row of rows) {
    if (await requeue(db, row.id, `no worker claimed it within ${olderThanSeconds}s`)) {
      requeued.push(row.id);
    }
  }

  return { requeued, failed: [], examined: rows.length };
}

export interface AbandonedOutbox {
  id: string;
  aggregateType: string;
  /** What the event is about - the one field an operator needs to act on it. */
  aggregateId: string;
  eventType: string;
  attempts: number;
  payload: Record<string, unknown>;
}

/**
 * Events the relay has given up on.
 *
 * Surfaced rather than deleted: an event that failed to publish ten times is
 * either a broken queue or a payload nothing can consume, and both are things a
 * human has to look at. Dropping it silently is how a generation disappears.
 */
export async function findAbandonedOutbox(
  db: Database,
  maxAttempts: number,
  limit = 100,
): Promise<AbandonedOutbox[]> {
  return db
    .select({
      id: outboxEvents.id,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      eventType: outboxEvents.eventType,
      attempts: outboxEvents.attempts,
      payload: outboxEvents.payload,
    })
    .from(outboxEvents)
    .where(sql`${outboxEvents.processedAt} IS NULL AND ${outboxEvents.attempts} >= ${maxAttempts}`)
    .limit(limit);
}

/**
 * Re-publishes an abandoned event.
 *
 * Used by admin replay. The attempt counter is reset because the row is back in
 * the pending set: leaving it at the limit would mean the relay never picks it
 * up again, which would make the replay a no-op that looks successful.
 */
export async function replayOutboxEvent(db: Database, eventId: string): Promise<boolean> {
  const rows = await db
    .update(outboxEvents)
    .set({ attempts: 0, processedAt: null })
    .where(eq(outboxEvents.id, eventId))
    .returning({ id: outboxEvents.id });

  return rows.length > 0;
}

export interface ReaperConfig extends LeaseConfig {
  /** Seconds between sweeps. */
  intervalSeconds: number;
  /** How long a PENDING job may sit unclaimed before it is re-queued. */
  orphanAfterSeconds: number;
  /** Events the relay abandons at, matching the relay's own limit. */
  outboxMaxAttempts: number;
  /** Rows examined per sweep. */
  batchSize: number;
}

export const DEFAULT_REAPER: ReaperConfig = {
  ...DEFAULT_LEASE,
  intervalSeconds: 60,
  orphanAfterSeconds: 120,
  outboxMaxAttempts: 10,
  batchSize: 50,
};

export interface ReaperReport extends SweepResult {
  /** Events the relay gave up on. Surfaced, never deleted. */
  abandonedOutbox: AbandonedOutbox[];
}

/**
 * Sweeps until aborted.
 *
 * `run()` is what `apps/reaper` calls; `tick()` is what a test calls. Split for
 * the same reason as the outbox relay: the decision is worth testing without a
 * timer.
 */
export class Reaper {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly config: ReaperConfig = DEFAULT_REAPER,
    private readonly log: (report: ReaperReport) => void = () => {},
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    const interval = this.config.intervalSeconds * 1000;

    while (!signal.aborted && this.running) {
      await this.tick();
      await this.sleep(interval);
    }
  }

  /** One full pass: leases, orphans, then the abandoned-event report. */
  async tick(): Promise<ReaperReport> {
    const leases = await sweepOnce(this.db, { maxAttempts: this.config.maxAttempts });
    const orphans = await sweepOrphanedPending(
      this.db,
      this.config.orphanAfterSeconds,
      this.config.batchSize,
    );
    const abandonedOutbox = await findAbandonedOutbox(
      this.db,
      this.config.outboxMaxAttempts,
      this.config.batchSize,
    );

    const report: ReaperReport = {
      requeued: [...leases.requeued, ...orphans.requeued],
      failed: leases.failed,
      examined: leases.examined + orphans.examined,
      abandonedOutbox,
    };

    this.log(report);

    return report;
  }

  stop(): void {
    this.running = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    });
  }
}
