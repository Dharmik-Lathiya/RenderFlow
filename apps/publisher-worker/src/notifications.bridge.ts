import { sql } from 'drizzle-orm';
import { notifications, type Database } from '@renderflow/db';
import type { PublishNotifier } from '@renderflow/social';

/**
 * Lets the publisher worker write notifications.
 *
 * `NotificationsService` lives in `apps/api` because it is an HTTP-facing
 * service with its own module. `apps/*` must not import each other (AGENTS.md
 * section 3), so the worker cannot reach it - and a worker that could not tell
 * anybody about a failed publish would fail the whole Phase 7 promise.
 *
 * This is the seam: the same write, owned by the worker, with no HTTP and no
 * Nest. The SQL is duplicated rather than shared through a lib on purpose -
 * extracting a one-table writer into `libs/` to save four lines would put
 * app-level policy (`dedupe_key` semantics) somewhere it does not belong. If a
 * third caller ever appears, it becomes a lib.
 */
export class NotificationsBridge implements PublishNotifier {
  constructor(private readonly db: Database) {}

  async notify(input: {
    userId: string;
    type: 'publish_failed' | 'publish_succeeded' | 'credit_refunded' | 'credits_low';
    title: string;
    body: string;
    dedupeKey?: string;
  }): Promise<void> {
    try {
      await this.db
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body,
          dedupeKey: input.dedupeKey ?? null,
        })
        // Matches the API service exactly, INCLUDING the predicates. Without
        // them Postgres rejects the statement against the PARTIAL unique index,
        // and the catch below would quietly turn that into notifications that
        // never appear - the exact failure this bridge exists to prevent.
        .onConflictDoUpdate({
          target: notifications.dedupeKey,
          set: { body: input.body },
          setWhere: sql`${notifications.dedupeKey} IS NOT NULL`,
          targetWhere: sql`${notifications.dedupeKey} IS NOT NULL`,
        });
    } catch (error) {
      // A worker that dies because it could not report a failure is a worker
      // that hides the failure. The publish job's own row is already updated by
      // the caller; this part is the part that is nice to have.
      process.stderr.write(`publisher-worker: could not write a notification: ${String(error)}\n`);
    }
  }
}
