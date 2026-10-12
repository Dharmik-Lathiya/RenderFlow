import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, notifications, type Notification } from '@renderflow/db';
import { childLogger } from '@renderflow/observability';

/** Derived from the enum column, so adding a type is a schema change and not two. */
export type NotificationType = Notification['type'];

const log = childLogger('notifications');

/**
 * In-app notifications (PROJECT.md section 12 Phase 7: "failure notifications
 * (in-app + email)").
 *
 * The write side is `notify()` and it is deliberately callable from a worker,
 * not just from a controller: the whole point is to tell somebody when a publish
 * fails, and that happens in a process that never sees a request.
 *
 * Nothing here emails anybody. Mail is Phase 9's concern and it has a
 * different failure mode - a bounced address, an unverified domain - so it
 * belongs behind its own seam rather than being the second thing this service
 * does.
 */

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * Makes the write idempotent.
   *
   * A publish that fails three times should tell the user once, not three
   * times. The publisher passes its job id, so the third attempt updates the
   * existing row instead of stacking another identical notification in the list.
   */
  dedupeKey?: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private db!: ReturnType<typeof getDb>;

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Records a notification.
   *
   * Never throws. A notification that fails to write must not take down the
   * worker that was trying to report something else - the original failure is
   * the one that matters, and the reporting path failing on top of it is noise
   * at best.
   *
   * But it is not silent: a swallowed error here is indistinguishable from
   * "there was nothing to report", and a notification centre that quietly
   * stopped working is how a product loses a user's trust in it. The failure is
   * logged with its context (AGENTS.md section 7: log or rethrow, never
   * swallow).
   */
  async notify(input: NotifyInput): Promise<void> {
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
        // A repeat of the same cause updates the existing row rather than
        // stacking another identical card in the user's list. Updating the body
        // matters as much as the title: the attempt count in it is the part that
        // changes between retries.
        //
        // Both predicates are REQUIRED, not decoration: the unique index is
        // partial (`WHERE dedupe_key IS NOT NULL`), and `ON CONFLICT (col)`
        // without a matching predicate does not match a partial index. Postgres
        // rejects the whole statement with "no unique or exclusion constraint
        // matching the ON CONFLICT specification" - which the catch below would
        // have turned into a centre that silently never fills again.
        .onConflictDoUpdate({
          target: notifications.dedupeKey,
          set: { body: input.body },
          setWhere: sql`${notifications.dedupeKey} IS NOT NULL`,
          targetWhere: sql`${notifications.dedupeKey} IS NOT NULL`,
        });
    } catch (error) {
      log.error(
        { err: error, userId: input.userId, type: input.type, dedupeKey: input.dedupeKey },
        'could not write a notification',
      );
    }
  }

  /** The caller's notifications, newest first. */
  async list(userId: string, unreadOnly = false, limit = 50): Promise<NotificationView[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        unreadOnly
          ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
          : eq(notifications.userId, userId),
      )
      .orderBy(sql`${notifications.createdAt} DESC`)
      .limit(limit);

    return rows.map(toView);
  }

  async countUnread(userId: string): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM notifications
       WHERE user_id = ${userId}::uuid AND read_at IS NULL
    `);

    return Number(rows.rows[0]?.n ?? '0');
  }

  /**
   * Marks one notification read.
   *
   * Scoped by `user_id` in the WHERE, not by id alone. Without it this is an
   * endpoint where any caller can mark any notification read by guessing a uuid,
   * and more importantly it reports success for rows that are not theirs.
   */
  async markRead(userId: string, notificationId: string): Promise<{ updated: boolean }> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });

    return { updated: updated.length > 0 };
  }

  /** Marks everything read. Returns how many were actually changed. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    return { updated: updated.length };
  }
}

function toView(row: Notification): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
