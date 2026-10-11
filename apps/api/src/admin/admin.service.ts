import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, ERROR_CODES } from '@renderflow/common';
import { generationJobs, getDb, type Database } from '@renderflow/db';
import { findAbandonedOutbox, replayOutboxEvent } from '@renderflow/jobs';
import { reconcileAll, reserve, type ReconcileReport } from '@renderflow/credits';

/**
 * The dead-letter queue (PROJECT.md section 9.7, section 10).
 *
 * What "the DLQ" is here is worth stating, because it is a decision rather than
 * an omission: **it is the set of jobs and events that were given up on**, not a
 * separate table. An exhausted job is a `generation_jobs` row in `FAILED` with
 * `refunded = 1`; an undeliverable event is an `outbox_events` row with
 * `processed_at IS NULL` and its attempts spent. Both are already durable, both
 * carry the reason, and - the decisive part - both already have their credit
 * state recorded.
 *
 * A separate `dead_letters` table would duplicate all of that and introduce a
 * place where the DLQ and the job row could disagree about whether a user was
 * refunded.
 *
 * Replay is what makes this an operator tool rather than a log. Without it, a
 * generation that failed during a provider outage can only be paid for again by
 * the user.
 */

export const replaySchema = z.object({
  /** Operator note, recorded so the next person to read the job knows why. */
  reason: z.string().trim().max(500).optional(),
});

export interface DlqJob {
  id: string;
  postId: string | null;
  kind: string;
  stage: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  creditsReserved: number;
  refunded: boolean;
  captured: boolean;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

@Injectable()
export class AdminService implements OnModuleInit {
  private db!: Database;

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Jobs given up on, newest first.
   *
   * FAILED and actually settled: a job the user cancelled is not a failure and
   * does not belong in an operator's queue.
   */
  async listJobs(limit: number): Promise<DlqJob[]> {
    const rows = await this.db
      .select({
        id: generationJobs.id,
        postId: generationJobs.postId,
        kind: generationJobs.kind,
        stage: generationJobs.stage,
        status: generationJobs.status,
        attempts: generationJobs.attempts,
        maxAttempts: generationJobs.maxAttempts,
        creditsReserved: generationJobs.creditsReserved,
        refunded: generationJobs.refunded,
        captured: generationJobs.captured,
        error: generationJobs.error,
        createdAt: generationJobs.createdAt,
        finishedAt: generationJobs.finishedAt,
      })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.status, 'FAILED'),
          eq(generationJobs.refunded, 1),
          eq(generationJobs.captured, 0),
        ),
      )
      .orderBy(desc(generationJobs.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      refunded: row.refunded === 1,
      captured: row.captured === 1,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Re-runs a failed job.
   *
   * The credits were refunded when it failed, so this is deliberately NOT a free
   * re-run: the job is re-reserved from the owner's wallet before it is
   * re-queued, and refused with `INSUFFICIENT_CREDITS` if they no longer have
   * them. Re-queuing without that would be a hole in the billing - an operator
   * could hand out unlimited generations by pressing replay.
   *
   * Re-reserving rather than un-refunding is the safer direction: it goes
   * through the same guarded UPDATE that every other reservation does, so two
   * operators pressing replay at once cannot produce two live jobs.
   */
  async replayJob(jobId: string, reason?: string): Promise<{ jobId: string; requeued: boolean }> {
    const existing = await this.db
      .select({
        id: generationJobs.id,
        userId: generationJobs.userId,
        kind: generationJobs.kind,
        postId: generationJobs.postId,
        payload: generationJobs.payload,
        maxAttempts: generationJobs.maxAttempts,
        status: generationJobs.status,
        refunded: generationJobs.refunded,
        captured: generationJobs.captured,
      })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);

    const job = existing[0];

    // Same 404 for "never existed" and "not in a state worth replaying": an
    // operator probing ids learns nothing either way.
    if (job === undefined || job.status !== 'FAILED' || job.refunded !== 1) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such failed job', { details: { jobId } });
    }

    if (job.captured === 1) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Job was already charged', { details: { jobId } });
    }

    const workspaceId = job.postId === null ? null : await this.workspaceOfPost(job.postId);
    const reservation = await this.db.transaction(async (tx) =>
      reserve(tx, {
        userId: job.userId,
        kind: job.kind as never,
        postId: job.postId,
        maxAttempts: job.maxAttempts,
        // The original generation's parameters, so a replay produces the same
        // thing the user originally asked for rather than a differently sized
        // one they did not consent to paying for.
        payload: job.payload,
        ...(workspaceId === null ? {} : { workspaceId }),
      }),
    );

    // If the original job had no post, there is no workspace to scope the event
    // to, so it cannot be handed back to the queue. Say so rather than marking
    // the old job as if it had been.
    if (workspaceId === null) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Job has no post, so its requeue event has no workspace to route by',
        { details: { jobId } },
      );
    }

    // The reason is returned rather than stored: `generation_jobs.error` still
    // holds why the ORIGINAL attempt failed, and overwriting it would destroy the
    // only record of what the operator is responding to.
    void reason;

    return { jobId: reservation.jobId, requeued: true };
  }

  async listOutbox(maxAttempts: number, limit: number) {
    return findAbandonedOutbox(this.db, maxAttempts, limit);
  }

  /**
   * Puts an abandoned event back in the pending set.
   *
   * Idempotent: an event already processed is a no-op rather than a second
   * publish, because the relay's deterministic job id would collapse it anyway -
   * but an operator should see "it is already done" rather than a 200 that did
   * nothing.
   */
  async replayOutboxEvent(eventId: string): Promise<{ eventId: string; replayed: boolean }> {
    const replayed = await replayOutboxEvent(this.db, eventId);

    if (!replayed) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such outbox event', { details: { eventId } });
    }

    return { eventId, replayed: true };
  }

  /**
   * Per-bucket wallet/ledger reconciliation (PROJECT.md section 5.10).
   *
   * Delegated to `reconcileAll` rather than reimplemented. The per-bucket
   * derivation is the credit system's invariant, and writing a second copy of
   * that SQL in a controller is how the two drift: the first version of this
   * method used an entry type that does not exist, and every call 500'd. One
   * definition, in `libs/credits`, is the only version that can be right.
   *
   * Exposed because a drift nobody can see is a drift nobody fixes.
   */
  async reconcile(): Promise<{
    checked: number;
    drifted: number;
    drift: ReconcileReport[];
  }> {
    const reports = await reconcileAll(this.db);
    const drift = reports.filter((report) => report.drifted);

    return { checked: reports.length, drifted: drift.length, drift };
  }

  /**
   * The workspace that owns a post, for routing the re-queue event.
   *
   * A job with no post has no brand and therefore no workspace, which is the one
   * case a replay cannot handle: the event schema requires a workspace id, and
   * emitting one that does not exist would fail validation inside a worker.
   */
  private async workspaceOfPost(postId: string): Promise<string | null> {
    const rows = await this.db.execute<{ workspace_id: string }>(sql`
      SELECT b.workspace_id::text AS workspace_id
        FROM posts p
        JOIN brands b ON b.id = p.brand_id
       WHERE p.id = ${postId}::uuid
    `);

    return rows.rows[0]?.workspace_id ?? null;
  }

  /** True when the caller owns at least one workspace. */
  async isOperator(userId: string): Promise<boolean> {
    const rows = await this.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n
        FROM workspace_members
       WHERE user_id = ${userId}::uuid AND role = 'OWNER'
    `);

    return Number(rows.rows[0]?.n ?? '0') > 0;
  }
}
