import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@renderflow/common';
import {
  assets,
  brands,
  getDb,
  outboxEvents,
  posts,
  publishJobs,
  socialAccounts,
  type PublishJob,
} from '@renderflow/db';
import { canPublish, platformContentFor, type SocialPlatform } from '@renderflow/social';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

/**
 * Scheduling (PROJECT.md section 10: `POST /posts/:id/schedule`).
 *
 * Three decisions are made here and nowhere else, because each of them is one a
 * worker must not be in a position to change:
 *
 *  - **Who may publish.** Publishing to a public profile is the most privileged
 *    act in the product, so it needs APPROVER - the same floor that approval
 *    needs. An EDITOR can write and submit; an APPROVER decides what the world
 *    sees.
 *  - **What the text will be.** Platform formatting runs at schedule time, not
 *    publish time, so what was approved is what goes out.
 *  - **When it is due.** `scheduled_for` is written once and read by the
 *    publisher. The relay's delayed queue entry is an optimisation on top; the
 *    row is the truth (AGENTS.md rule 6 - no queue pushes from a handler).
 */

export const scheduleSchema = z.object({
  scheduledAt: z.coerce.date(),
  accountIds: z.array(z.uuid()).min(1).max(10),
});

export interface ScheduleResult {
  postId: string;
  scheduledAt: string;
  jobs: PublishJobView[];
  /** True when an Idempotency-Key matched an existing schedule. */
  replayed: boolean;
}

export interface PublishJobView {
  id: string;
  postId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  status: string;
  scheduledFor: string;
  externalPostId: string | null;
  externalUrl: string | null;
  error: string | null;
  /** What the formatting rules changed, so the UI can show it before approval. */
  notes: string[];
}

@Injectable()
export class PublishingService implements OnModuleInit {
  private db!: ReturnType<typeof getDb>;

  constructor(private readonly access: WorkspaceAccessService) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Schedules a post to one or more connected accounts.
   *
   * Every account is verified to belong to the POST's workspace. That check is
   * the whole tenancy story for this endpoint: without it, an APPROVER of
   * workspace A could schedule workspace A's post onto workspace B's account
   * and publish from it, which is both a data leak and a way to post to a
   * profile you were never given.
   */
  async schedule(
    userId: string,
    postId: string,
    input: z.infer<typeof scheduleSchema>,
    idempotencyKey: string | undefined,
  ): Promise<ScheduleResult> {
    const scoped = await this.access.scope({
      userId,
      resource: 'post',
      required: 'APPROVER',
      lookup: async (db) => {
        const rows = await db
          .select({
            id: posts.id,
            workspaceId: brands.workspaceId,
            caption: posts.caption,
            hashtags: posts.hashtags,
            status: posts.status,
            brandId: posts.brandId,
          })
          .from(posts)
          .innerJoin(brands, eq(brands.id, posts.brandId))
          .where(eq(posts.id, postId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    const { caption, hashtags, status } = scoped.value;

    // A scheduled time in the past is almost always a timezone bug on the
    // client, and "publish immediately" is a different thing to ask for.
    if (input.scheduledAt.getTime() <= Date.now()) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'scheduledAt must be in the future');
    }

    // Only an approved post may be scheduled. Approving and scheduling are two
    // steps on purpose: a post can be reviewed by one person and queued by
    // another, and the queueing must never be the thing that reviews it.
    if (status !== 'APPROVED') {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `only an approved post can be scheduled; this one is ${status}`,
      );
    }

    const accounts = await this.loadAccounts(scoped.workspaceId, input.accountIds);
    const mediaKey = await this.primaryMedia(postId);

    const prepared = accounts.map((account) => {
      const formatted = platformContentFor(account.platform, caption ?? '', parseTags(hashtags));
      const check = canPublish(account.platform, formatted, mediaKey !== null);

      if (!check.ok) {
        // Refused HERE, before the row exists. The alternative is a scheduled
        // post the platform rejects with a 400 minutes later, after the user has
        // been told it was queued.
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          check.reason ?? 'this post cannot be published',
        );
      }

      return { account, content: formatted.content, notes: formatted.notes };
    });

    const scheduledAt = input.scheduledAt;

    // A retried request is answered with the schedule that already exists,
    // rather than a 409. The key is scoped PER ACCOUNT because one schedule
    // creates one row per target: a single shared value would collide with itself
    // on the unique index the moment a post went to two accounts.
    const keyPrefix = idempotencyKey === undefined ? null : `${idempotencyKey}:`;

    if (keyPrefix !== null) {
      const replay = await this.replayOf(scoped.value.id, keyPrefix);

      if (replay !== null) {
        return { postId, scheduledAt: scheduledAt.toISOString(), jobs: replay, replayed: true };
      }
    }

    // Already queued for one of these accounts? Say so up front, rather than
    // letting one of three targets silently disappear.
    const alreadyScheduled = await this.conflictingAccounts(
      postId,
      accounts.map((account) => account.id),
    );

    if (alreadyScheduled.length > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `this post is already scheduled to ${alreadyScheduled.length} of the requested accounts`,
      );
    }

    const jobs = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(publishJobs)
        .values(
          prepared.map(({ account, content }) => ({
            postId,
            socialAccountId: account.id,
            status: 'SCHEDULED' as const,
            scheduledFor: scheduledAt,
            platformContent: content,
            mediaKey,
            idempotencyKey: keyPrefix === null ? null : `${keyPrefix}${account.id}`,
          })),
        )
        .onConflictDoNothing()
        .returning({
          id: publishJobs.id,
          socialAccountId: publishJobs.socialAccountId,
        });

      // All or nothing. `onConflictDoNothing` absorbs the unique-index race
      // between two concurrent schedules, but honouring a partial insert would
      // silently drop a target the user explicitly asked for. Throwing rolls the
      // transaction back, including the outbox rows below, so a half-scheduled
      // post cannot exist.
      if (inserted.length !== prepared.length) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'this post is already scheduled to one of the requested accounts',
        );
      }

      // One outbox event PER publish job, so `aggregate_id` is the publish job
      // and the relay's deterministic `generation:<aggregateId>` job id is unique
      // per target. One event for the whole post would give three targets a
      // single queue entry, and BullMQ would drop two of them.
      for (const job of inserted) {
        await tx.insert(outboxEvents).values({
          aggregateType: 'PUBLISH_JOB',
          aggregateId: job.id,
          eventType: 'post.scheduled',
          dedupeKey: `PUBLISH:${job.id}:post.scheduled`,
          payload: {
            eventType: 'post.scheduled',
            postId,
            scheduledAt: scheduledAt.toISOString(),
            publishJobIds: [job.id],
          },
        });
      }

      return inserted;
    });

    return {
      postId,
      scheduledAt: scheduledAt.toISOString(),
      jobs: await this.viewsFor(jobs.map((job) => job.id)),
      replayed: false,
    };
  }

  /**
   * The schedule a previous request with this Idempotency-Key already made.
   *
   * Matching on a prefix rather than a stored bare key, because one schedule
   * writes one row per account and a single stored value would collide with
   * itself. The rows are already being fetched for the post, so this costs
   * nothing extra.
   */
  private async replayOf(postId: string, keyPrefix: string): Promise<PublishJobView[] | null> {
    const rows = await this.db
      .select({ job: publishJobs, platform: socialAccounts.platform })
      .from(publishJobs)
      .innerJoin(socialAccounts, eq(socialAccounts.id, publishJobs.socialAccountId))
      .where(eq(publishJobs.postId, postId));

    const matched = rows.filter((row) => row.job.idempotencyKey?.startsWith(keyPrefix) === true);

    return matched.length === 0 ? null : matched.map((row) => toView(row.job, row.platform));
  }

  /** Accounts among `accountIds` this post already has a live job for. */
  private async conflictingAccounts(
    postId: string,
    accountIds: readonly string[],
  ): Promise<string[]> {
    const rows = await this.db
      .select({ socialAccountId: publishJobs.socialAccountId })
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.postId, postId),
          inArray(publishJobs.socialAccountId, [...accountIds]),
          // A PUBLISHED or FAILED row is history. Blocking on it would make a
          // post impossible to reschedule, which is exactly what someone wants to
          // do after a platform outage.
          inArray(publishJobs.status, ['PENDING', 'SCHEDULED', 'PUBLISHING']),
        ),
      );

    return rows.map((row) => row.socialAccountId);
  }

  private async viewsFor(jobIds: readonly string[]): Promise<PublishJobView[]> {
    const rows = await this.db
      .select({ job: publishJobs, platform: socialAccounts.platform })
      .from(publishJobs)
      .innerJoin(socialAccounts, eq(socialAccounts.id, publishJobs.socialAccountId))
      .where(inArray(publishJobs.id, [...jobIds]));

    return rows.map((row) => toView(row.job, row.platform));
  }

  /**
   * Cancels everything still pending for a post.
   *
   * Only rows that have not started are touched. A PUBLISHING job is in flight -
   * cancelling it would be a lie, because the post may already be on the
   * platform and there is no calling that back.
   */
  async cancel(userId: string, postId: string): Promise<{ cancelled: number }> {
    await this.access.scope({
      userId,
      resource: 'post',
      required: 'APPROVER',
      lookup: async (db) => {
        const rows = await db
          .select({ workspaceId: brands.workspaceId, id: posts.id })
          .from(posts)
          .innerJoin(brands, eq(brands.id, posts.brandId))
          .where(eq(posts.id, postId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    const cancelled = await this.db
      .update(publishJobs)
      .set({ status: 'FAILED', error: 'cancelled before publishing', updatedAt: new Date() })
      .where(
        and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ['PENDING', 'SCHEDULED'])),
      )
      .returning({ id: publishJobs.id });

    return { cancelled: cancelled.length };
  }

  /** The publish history for a post, scoped to the caller's workspace. */
  async listForPost(userId: string, postId: string): Promise<PublishJobView[]> {
    return this.jobsFor(userId, postId);
  }

  private async jobsFor(userId: string, postId: string): Promise<PublishJobView[]> {
    const scoped = await this.access.scope({
      userId,
      resource: 'post',
      lookup: async (db) => {
        const rows = await db
          .select({ workspaceId: brands.workspaceId, id: posts.id })
          .from(posts)
          .innerJoin(brands, eq(brands.id, posts.brandId))
          .where(eq(posts.id, postId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    const rows = await this.db
      .select({ job: publishJobs, platform: socialAccounts.platform })
      .from(publishJobs)
      .innerJoin(socialAccounts, eq(socialAccounts.id, publishJobs.socialAccountId))
      .where(eq(publishJobs.postId, scoped.value.id));

    return rows.map((row) => toView(row.job, row.platform));
  }

  /**
   * Loads the requested accounts and refuses any that is not ours.
   *
   * A missing account and a foreign account produce the SAME error, for the same
   * reason `WorkspaceAccessService` does it: a caller who can tell the two apart
   * learns which account ids exist in workspaces they cannot see.
   */
  private async loadAccounts(
    workspaceId: string,
    accountIds: readonly string[],
  ): Promise<{ id: string; platform: SocialPlatform }[]> {
    const rows = await this.db
      .select({ id: socialAccounts.id, platform: socialAccounts.platform })
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.workspaceId, workspaceId),
          inArray(socialAccounts.id, [...accountIds]),
        ),
      );

    if (rows.length !== new Set(accountIds).size) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        'one or more social accounts do not belong to this workspace',
      );
    }

    return rows;
  }

  /**
   * The media a post publishes with, if any.
   *
   * Only CONFIRMED assets: the row is written before the upload so the presigned
   * URL can name the object, which means a row can exist with nothing behind it.
   * Publishing that key would hand the platform a 404.
   *
   * Readiness lives in `meta.status` rather than a column, because it is set by
   * a storage HEAD rather than by anything the API decides - see
   * `StudioService.confirmUpload`.
   *
   * The FIRST one in creation order. A carousel would need all of them, and
   * treating "the first one" as the whole set would publish a one-image carousel
   * without saying so.
   */
  private async primaryMedia(postId: string): Promise<string | null> {
    const rows = await this.db
      .select({ key: assets.storageKey, meta: assets.meta })
      .from(assets)
      .where(eq(assets.postId, postId))
      .orderBy(assets.createdAt);

    const confirmed = rows.find((row) => row.meta.status === 'READY');
    return confirmed?.key ?? null;
  }
}

function toView(job: PublishJob, platform: SocialPlatform): PublishJobView {
  return {
    id: job.id,
    postId: job.postId,
    socialAccountId: job.socialAccountId,
    platform,
    status: job.status,
    scheduledFor: job.scheduledFor.toISOString(),
    externalPostId: job.externalPostId,
    externalUrl: job.externalUrl,
    error: job.error,
    // Not stored on the row: the platform text is already formatted, so
    // re-deriving the notes would mean re-running the rules and hoping they
    // still agree. The UI shows the stored text.
    notes: [],
  };
}

/** `#one #two`, or a JSON array, or empty. Stored as a plain string by the API. */
function parseTags(hashtags: string): string[] {
  const trimmed = hashtags.trim();

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : [];
    } catch {
      return [];
    }
  }

  return trimmed === '' ? [] : trimmed.split(/\s+/).filter((tag) => tag !== '');
}
