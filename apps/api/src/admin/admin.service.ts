import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, ERROR_CODES } from '@renderflow/common';
import { auditLogs, getDb, type Database } from '@renderflow/db';
import { findAbandonedOutbox, replayOutboxEvent } from '@renderflow/jobs';
import {
  CreditError,
  adjust,
  getBalance,
  reconcileAll,
  reconcileUser,
  reserve,
  type ReconcileReport,
  type WalletBalance,
} from '@renderflow/credits';

/**
 * The operator surface (PROJECT.md sections 9.7, 10 and 12 Phase 9).
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
 *
 * Tenancy
 * -------
 * Two kinds of operator exist:
 *
 *  - a global `ADMIN` (the `users.role` enum has had this value since Phase 1),
 *    who sees every workspace;
 *  - a workspace `OWNER`, who sees only the workspaces they own.
 *
 * The earlier version of this service treated every workspace owner as global,
 * which meant one customer's owner could replay another customer's job and read
 * their failure. Scoping is applied in SQL for the list queries and re-checked
 * before every mutation, because hiding a row in the list is not authorization.
 */

export const replaySchema = z.object({
  /** Operator note, recorded so the next person to read the job knows why. */
  reason: z.string().trim().max(500).optional(),
});

export const adjustSchema = z.object({
  userId: z.uuid(),
  /**
   * Whole credits, positive or negative, never zero.
   *
   * A bound exists so a fat-fingered extra zero is refused rather than granted:
   * 1,000,000 credits is already far outside any real correction.
   */
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, 'amount must be non-zero')
    .refine((value) => Math.abs(value) <= 1_000_000, 'amount must be at most 1,000,000'),
  reason: z.string().trim().min(3).max(500),
  /**
   * Makes a retried adjustment idempotent.
   *
   * The ledger's unique `(reference_type, reference_id, entry_type)` is the
   * mechanism: replaying the same reference is a conflict, not a second grant.
   */
  referenceId: z.string().trim().min(1).max(200).optional(),
});

export type AdjustInput = z.infer<typeof adjustSchema>;

export interface OperatorScope {
  userId: string;
  /** True for a global ADMIN; false for a workspace OWNER. */
  global: boolean;
  /** The workspaces an OWNER may see. Empty for a global admin. */
  workspaceIds: string[];
}

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

type DlqJobRow = {
  id: string;
  post_id: string | null;
  kind: string;
  stage: string;
  status: string;
  attempts: number;
  max_attempts: number;
  credits_reserved: number;
  refunded: number;
  captured: number;
  error: string | null;
  // Raw `db.execute` hands back the driver's values. node-postgres returns a
  // string here (drizzle does not install its own parser), so the mapper accepts
  // either shape rather than throwing "toISOString is not a function" on a
  // perfectly valid row. See `isoTimestamp` below.
  created_at: string | Date;
  finished_at: string | Date | null;
};

export interface AdjustResult {
  userId: string;
  amount: number;
  balance: WalletBalance;
  referenceId: string | null;
  /**
   * False when the reference id matched an adjustment that had already been
   * applied. The balance returned is the CURRENT one either way, so a retried
   * request can be answered without applying anything twice.
   */
  applied: boolean;
}

@Injectable()
export class AdminService implements OnModuleInit {
  private db!: Database;

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Resolves what an operator may see, or null when they are not one.
   *
   * One query for both kinds: a global admin needs no workspace rows, and an
   * owner's memberships are aggregated in the same round trip.
   */
  async operatorScope(userId: string): Promise<OperatorScope | null> {
    const rows = await this.db.execute<{
      role: string;
      workspace_ids: string[] | null;
    }>(sqlOperatorScope(userId));

    const row = rows.rows[0];

    if (row === undefined) {
      return null;
    }

    if (row.role === 'ADMIN') {
      return { userId, global: true, workspaceIds: [] };
    }

    const workspaceIds = (row.workspace_ids ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );

    if (workspaceIds.length === 0) {
      return null;
    }

    return { userId, global: false, workspaceIds };
  }

  /** Throws the same refusal for "not an operator" and "no workspace". */
  async requireOperator(userId: string): Promise<OperatorScope> {
    const scope = await this.operatorScope(userId);

    if (scope === null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Operator role required', {
        details: { required: 'ADMIN, or OWNER of a workspace' },
      });
    }

    return scope;
  }

  /** Kept for callers that only need a yes/no. */
  async isOperator(userId: string): Promise<boolean> {
    return (await this.operatorScope(userId)) !== null;
  }

  /**
   * Jobs given up on, newest first.
   *
   * FAILED and actually settled: a job the user cancelled is not a failure and
   * does not belong in an operator's queue. Scoped in SQL, so a foreign row is
   * never read, let alone returned.
   */
  async listJobs(scope: OperatorScope, limit: number): Promise<DlqJob[]> {
    const rows = await this.db.execute<DlqJobRow>(sql`
      SELECT gj.id,
             gj.post_id,
             gj.kind,
             gj.stage::text AS stage,
             gj.status::text AS status,
             gj.attempts,
             gj.max_attempts,
             gj.credits_reserved,
             gj.refunded,
             gj.captured,
             gj.error,
             gj.created_at,
             gj.finished_at
        FROM generation_jobs gj
       WHERE gj.status = 'FAILED'
         AND gj.refunded = 1
         AND gj.captured = 0
         AND (
           ${scope.global}::boolean
           OR EXISTS (
             SELECT 1
               FROM posts p
               JOIN brands b ON b.id = p.brand_id
              WHERE p.id = gj.post_id
                AND b.workspace_id = ANY(${uuidArray(scope.workspaceIds)})
           )
         )
       ORDER BY gj.created_at DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      postId: row.post_id,
      kind: row.kind,
      stage: row.stage,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      creditsReserved: row.credits_reserved,
      refunded: row.refunded === 1,
      captured: row.captured === 1,
      error: row.error,
      createdAt: isoTimestamp(row.created_at),
      finishedAt: row.finished_at === null ? null : isoTimestamp(row.finished_at),
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
  async replayJob(
    scope: OperatorScope,
    jobId: string,
    reason?: string,
  ): Promise<{ jobId: string; requeued: boolean }> {
    const existing = await this.db.execute<{
      id: string;
      user_id: string;
      kind: string;
      post_id: string | null;
      payload: Record<string, unknown>;
      max_attempts: number;
      status: string;
      refunded: number;
      captured: number;
      workspace_id: string | null;
    }>(sql`
      SELECT gj.id,
             gj.user_id,
             gj.kind,
             gj.post_id,
             gj.payload,
             gj.max_attempts,
             gj.status::text AS status,
             gj.refunded,
             gj.captured,
             b.workspace_id
        FROM generation_jobs gj
        LEFT JOIN posts p ON p.id = gj.post_id
        LEFT JOIN brands b ON b.id = p.brand_id
       WHERE gj.id = ${jobId}::uuid
       LIMIT 1
    `);

    const job = existing.rows[0];

    // Same 404 for "never existed", "not worth replaying" and "not yours": an
    // operator probing ids learns nothing either way.
    if (
      job === undefined ||
      job.status !== 'FAILED' ||
      job.refunded !== 1 ||
      (!scope.global &&
        (job.workspace_id === null || !scope.workspaceIds.includes(job.workspace_id)))
    ) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such failed job', { details: { jobId } });
    }

    if (job.captured === 1) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Job was already charged', { details: { jobId } });
    }

    const reservation = await this.db.transaction(async (tx) =>
      reserve(tx, {
        userId: job.user_id,
        kind: job.kind as never,
        postId: job.post_id,
        maxAttempts: job.max_attempts,
        // The original generation's parameters, so a replay produces the same
        // thing the user originally asked for rather than a differently sized
        // one they did not consent to paying for.
        payload: job.payload,
        ...(job.workspace_id === null ? {} : { workspaceId: job.workspace_id }),
      }),
    );

    await this.record(scope.userId, 'dlq.replay', 'job', jobId, {
      reason: reason ?? null,
      requeuedJobId: reservation.jobId,
    });

    return { jobId: reservation.jobId, requeued: true };
  }

  async listOutbox(scope: OperatorScope, maxAttempts: number, limit: number) {
    const events = await findAbandonedOutbox(this.db, maxAttempts, limit);

    if (scope.global) {
      return events;
    }

    // Only job events can be resolved to a workspace through the schema today.
    // A `user.registered` event has no workspace, so a scoped operator cannot
    // see it - hiding it is the safe direction, and the global admin still can.
    const jobIds = events
      .filter((event) => event.aggregateType === 'JOB')
      .map((event) => event.aggregateId);

    const allowed = await this.jobsInWorkspaces(jobIds, scope.workspaceIds);

    return events.filter(
      (event) => event.aggregateType === 'JOB' && allowed.has(event.aggregateId),
    );
  }

  /**
   * Puts an abandoned event back in the pending set.
   *
   * Idempotent: an event already processed is a no-op rather than a second
   * publish, because the relay's deterministic job id would collapse it anyway -
   * but an operator should see "it is already done" rather than a 200 that did
   * nothing.
   */
  async replayOutboxEvent(
    scope: OperatorScope,
    eventId: string,
  ): Promise<{ eventId: string; replayed: boolean }> {
    const rows = await this.db.execute<{
      aggregate_type: string;
      aggregate_id: string;
    }>(sql`
      SELECT aggregate_type, aggregate_id
        FROM outbox_events
       WHERE id = ${eventId}::uuid
       LIMIT 1
    `);

    const event = rows.rows[0];

    if (event === undefined) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such outbox event', {
        details: { eventId },
      });
    }

    if (!scope.global) {
      const allowed =
        event.aggregate_type === 'JOB'
          ? await this.jobsInWorkspaces([event.aggregate_id], scope.workspaceIds)
          : new Set<string>();

      if (!allowed.has(event.aggregate_id)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'No such outbox event', {
          details: { eventId },
        });
      }
    }

    const replayed = await replayOutboxEvent(this.db, eventId);

    if (!replayed) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such outbox event', { details: { eventId } });
    }

    await this.record(scope.userId, 'dlq.outbox.replay', 'outbox_event', eventId, {});

    return { eventId, replayed: true };
  }

  /**
   * Per-bucket wallet/ledger reconciliation (PROJECT.md section 5.10).
   *
   * Delegated to `reconcileAll` / `reconcileUser` rather than reimplemented. The
   * per-bucket derivation is the credit system's invariant, and writing a second
   * copy of that SQL in a controller is how the two drift: the first version of
   * this method used an entry type that does not exist, and every call 500'd.
   *
   * A scoped operator reconciles only the users who belong to their workspaces:
   * the report exposes balances, and "which customer is short of credits" is not
   * something one tenant should learn about another.
   */
  async reconcile(scope: OperatorScope): Promise<{
    checked: number;
    drifted: number;
    drift: ReconcileReport[];
  }> {
    const reports = scope.global
      ? await reconcileAll(this.db)
      : await (async () => {
          const rows = await this.db.execute<{ user_id: string }>(sql`
            SELECT DISTINCT wm.user_id::text AS user_id
              FROM workspace_members wm
             WHERE wm.workspace_id = ANY(${uuidArray(scope.workspaceIds)})
          `);

          const out: ReconcileReport[] = [];
          for (const row of rows.rows) {
            out.push(await reconcileUser(this.db, row.user_id));
          }
          return out;
        })();

    const drift = reports.filter((report) => report.drifted);

    return { checked: reports.length, drifted: drift.length, drift };
  }

  /**
   * A manual credit adjustment, with its audit row in the same transaction.
   *
   * `libs/credits` is still the only writer of `wallets`/`credit_ledger`:
   * `adjust` is its audited entry point, and the reason is mandatory because an
   * adjustment with no reason is indistinguishable from a bug that touched a
   * balance. The `audit_logs` row records the operator and the endpoint; the
   * ledger row records the movement. Neither alone tells the whole story.
   */
  async adjustCredits(scope: OperatorScope, input: AdjustInput): Promise<AdjustResult> {
    const allowed = await this.db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok
        FROM users u
       WHERE u.id = ${input.userId}::uuid
         AND (
           ${scope.global}::boolean
           OR EXISTS (
             SELECT 1
               FROM workspace_members wm
              WHERE wm.user_id = u.id
                AND wm.workspace_id = ANY(${uuidArray(scope.workspaceIds)})
           )
         )
       LIMIT 1
    `);

    if (allowed.rows.length === 0) {
      // The same 404 a nonexistent user gets: an operator cannot use this route
      // to discover who belongs to another tenant.
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No such user', {
        details: { userId: input.userId },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        await adjust(tx, {
          userId: input.userId,
          amount: input.amount,
          reason: input.reason,
          actorId: scope.userId,
          ...(input.referenceId === undefined ? {} : { referenceId: input.referenceId }),
        });

        await tx.insert(auditLogs).values({
          actorId: scope.userId,
          action: 'credits.adjust',
          entity: 'user',
          entityId: input.userId,
          meta: {
            amount: input.amount,
            reason: input.reason,
            referenceId: input.referenceId ?? null,
          },
        });

        const balance = await getBalance(tx, input.userId);

        return {
          userId: input.userId,
          amount: input.amount,
          balance,
          referenceId: input.referenceId ?? null,
          applied: true,
        };
      });
    } catch (error) {
      /**
       * A retried request with the same reference id collides on the ledger's
       * unique `(reference_type, reference_id, entry_type)` index, which is the
       * mechanism that makes the adjustment idempotent. The transaction rolled
       * back, so the only correct answer is the current balance plus
       * `applied: false`.
       */
      if (input.referenceId !== undefined && isUniqueViolation(error)) {
        return {
          userId: input.userId,
          amount: input.amount,
          balance: await getBalance(this.db, input.userId),
          referenceId: input.referenceId,
          applied: false,
        };
      }

      // A refusal by the credit engine - an amount the wallet cannot absorb, or
      // no wallet at all - is a bad request, not a server fault. Without this
      // translation the global filter would answer 500 and hide the reason the
      // operator needs to act on.
      if (error instanceof CreditError) {
        throw new AppError(
          error.code === 'WALLET_NOT_FOUND' ? ERROR_CODES.NOT_FOUND : ERROR_CODES.VALIDATION_FAILED,
          error.message,
          { details: { userId: input.userId } },
        );
      }

      throw error;
    }
  }

  /** Writes an operator audit row for an action that does not move credits. */
  private async record(
    actorId: string,
    action: string,
    entity: string,
    entityId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(auditLogs).values({ actorId, action, entity, entityId, meta });
  }

  /**
   * Which of these jobs belong to the given workspaces.
   *
   * A job with no post has no workspace and is therefore never in the set, which
   * is the right answer for a scoped operator.
   */
  private async jobsInWorkspaces(
    jobIds: readonly string[],
    workspaceIds: readonly string[],
  ): Promise<Set<string>> {
    if (jobIds.length === 0 || workspaceIds.length === 0) {
      return new Set();
    }

    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT gj.id
        FROM generation_jobs gj
        JOIN posts p ON p.id = gj.post_id
        JOIN brands b ON b.id = p.brand_id
       WHERE gj.id = ANY(${uuidArray(jobIds)})
         AND b.workspace_id = ANY(${uuidArray(workspaceIds)})
    `);

    return new Set(rows.rows.map((row) => row.id));
  }
}

/**
 * A `uuid[]` exactly as the SQL above needs it.
 *
 * Built as `ARRAY[...]` rather than `ANY(${ids}::uuid[])` on purpose: a
 * JavaScript array interpolated into a `sql` template is expanded as a value
 * list, which for a single element produces `ANY(($1)::uuid[])` and lets
 * Postgres read the parameter as a bare string - `malformed array literal`.
 * `sql.join` keeps every id a typed uuid parameter, and the empty list is a
 * valid empty array that matches nothing.
 */
/**
 * A timestamp from a raw query, as an ISO string.
 *
 * `db.execute` returns whatever node-postgres hands back, and for `timestamptz`
 * that is a string unless a parser was installed. Normalising here keeps the API
 * contract (`createdAt` is an ISO string) independent of the driver's choice.
 */
function isoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uuidArray(ids: readonly string[]) {
  if (ids.length === 0) {
    return sql`ARRAY[]::uuid[]`;
  }

  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}

/**
 * The operator-scope query, kept out of the method so the SQL reads as one
 * statement rather than as string concatenation inside it.
 */
function sqlOperatorScope(userId: string) {
  return sql`
    SELECT u.role::text AS role,
           ARRAY_AGG(DISTINCT wm.workspace_id)
             FILTER (WHERE wm.role = 'OWNER') AS workspace_ids
      FROM users u
      LEFT JOIN workspace_members wm ON wm.user_id = u.id
     WHERE u.id = ${userId}::uuid
     GROUP BY u.id, u.role
  `;
}

/**
 * Postgres' unique-violation SQLSTATE, including when a driver wraps the error.
 *
 * `drizzle-orm` wraps a failed statement in a `DrizzleQueryError` with the
 * original as `cause`, so checking only the top level would turn "already
 * applied" into a 500.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === '23505'
    ) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
