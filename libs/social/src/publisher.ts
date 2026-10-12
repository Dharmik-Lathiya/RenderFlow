import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { publishJobs, socialAccounts, type Database } from '@renderflow/db';
import {
  PublishError,
  formatForPlatform,
  type FormatResult,
  type SocialAdapter,
  type SocialPlatform,
} from './adapter';

/**
 * Publishing (PROJECT.md section 9.5, Phase 7).
 *
 * The one guarantee this whole module exists to provide: **a post is published
 * exactly once.** Everything else - retries, rate limits, token refresh - is in
 * service of that.
 *
 * The guarantee rests on three independent checks, because any one of them can
 * be defeated by a process dying at the wrong moment:
 *
 *  1. **`publish_jobs.external_post_id`.** Set the first time a platform confirms
 *     a post. Once set, every later attempt returns it instead of publishing.
 *  2. **`adapter.findExternalPost(key)`** is called BEFORE every publish, not
 *     after a failure. This is the check that survives the worst case: the
 *     platform accepted the post and the worker died before we wrote anything
 *     down. On restart, row 1 is empty, so only row 2 can catch it.
 *  3. **The deterministic idempotency key** derived from the job id, which the
 *     platform itself dedupes on.
 *
 * Two of the three are in the database and one is at the platform. That is
 * deliberate: the failure this is protecting against is losing our own state, so
 * a check that lives only in our state would fail exactly when it is needed.
 */

export interface PublishDeps {
  db: Database;
  /** One adapter per platform. */
  adapterFor: (platform: SocialPlatform) => SocialAdapter;
}

export interface PublishOutcome {
  jobId: string;
  /**
   * `PUBLISHED`   - the platform has it.
   * `RECOVERED`   - the platform already had it from an earlier attempt we never
   *                 recorded; found rather than re-published.
   * `ALREADY`     - our row already recorded it; nothing was sent.
   * `RETRY`       - failed, attempts remain, the row is claimable again.
   * `FAILED`      - failed with nothing left to try.
   */
  status: 'PUBLISHED' | 'RECOVERED' | 'ALREADY' | 'RETRY' | 'FAILED';
  externalPostId: string | null;
  externalUrl: string | null;
  /** True when the post was found already at the platform rather than created. */
  recovered: boolean;
  error?: string;
}

export interface PublishJobRow {
  id: string;
  postId: string;
  socialAccountId: string;
  status: string;
  scheduledFor: Date;
  platformContent: string;
  mediaKey: string | null;
  attempts: number;
  maxAttempts: number;
  workerId: string | null;
  lockedUntil: Date | null;
  externalPostId: string | null;
  externalUrl: string | null;
  error: string | null;
}

/** One claimed row. */
export interface ClaimedPublishJob {
  job: PublishJobRow;
  platform: SocialPlatform;
  idempotencyKey: string;
}

export interface ClaimOptions {
  /** Publish jobs are due when `scheduled_for` has passed. */
  now?: Date;
  batchSize?: number;
  workerId?: string;
  /** Milliseconds a claim is held before the reaper may take it. */
  leaseSeconds?: number;
}

/**
 * Claims due, unclaimed publish jobs.
 *
 * `FOR UPDATE SKIP LOCKED` so two publishers cannot take the same row. As with
 * the generation reaper, that partitions work inside the claim transaction and
 * does NOT reserve the row afterwards - which is why the idempotency checks
 * above exist rather than being assumed.
 */
export async function claimPublishJobs(
  deps: PublishDeps,
  options: ClaimOptions = {},
): Promise<ClaimedPublishJob[]> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 10;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const workerId = options.workerId ?? null;

  const rows = await deps.db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id
        FROM publish_jobs
       WHERE status IN ('PENDING','SCHEDULED')
         AND scheduled_for <= ${now}
         AND (locked_until IS NULL OR locked_until < ${now})
       ORDER BY scheduled_for
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    `);

    if (due.rows.length === 0) {
      return [];
    }

    const ids = due.rows.map((row) => row.id);

    // `inArray`, not a hand-rolled `sql.join`: the latter splices the values into
    // ONE comma-separated parameter, which Postgres rejects as a syntax error.
    // The same trap is why `locked_until` is computed here rather than with
    // `make_interval(secs => $n)` - a bound parameter inside an interval
    // constructor is not an expression Postgres will accept either.
    await tx
      .update(publishJobs)
      .set({
        status: 'PUBLISHING',
        workerId,
        heartbeatAt: now,
        lockedUntil: new Date(now.getTime() + leaseSeconds * 1_000),
        attempts: sql`${publishJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(publishJobs.id, ids));

    return ids;
  });

  const claimed: ClaimedPublishJob[] = [];

  for (const id of rows) {
    const full = await loadJob(deps.db, id);

    if (full === null) {
      continue;
    }

    claimed.push({
      job: full.job,
      platform: full.platform,
      idempotencyKey: publishIdempotencyKey(id),
    });
  }

  return claimed;
}

async function loadJob(db: Database, jobId: string): Promise<ClaimedPublishJob | null> {
  const jobs = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId)).limit(1);

  const job = jobs[0];
  if (job === undefined) {
    return null;
  }

  const accounts = await db
    .select({ platform: socialAccounts.platform })
    .from(socialAccounts)
    .where(eq(socialAccounts.id, job.socialAccountId))
    .limit(1);

  const platform = accounts[0]?.platform;
  if (platform === undefined) {
    return null;
  }

  return { job, platform, idempotencyKey: publishIdempotencyKey(jobId) };
}

/**
 * The key the platform dedupes on.
 *
 * Derived from the job id rather than supplied, so it cannot differ between two
 * workers that both believe they are publishing the same thing.
 */
export function publishIdempotencyKey(jobId: string): string {
  return `renderflow:${jobId}`;
}

/**
 * Publishes one job.
 *
 * The order below is the whole design. Each check comes before the action it
 * guards, and none of them is skipped for being "probably fine".
 */
export async function publishJob(
  deps: PublishDeps,
  claimed: ClaimedPublishJob,
): Promise<PublishOutcome> {
  const { job, platform, idempotencyKey } = claimed;
  const adapter = deps.adapterFor(platform);

  // 1. Our own record. Cheapest, and covers the ordinary re-delivery.
  if (job.externalPostId !== null && job.externalPostId !== '') {
    return {
      jobId: job.id,
      status: 'ALREADY',
      externalPostId: job.externalPostId,
      externalUrl: job.externalUrl,
      recovered: false,
    };
  }

  // 2. The platform. Covers the case our record cannot: the platform accepted
  //    the post and we died before recording it.
  const alreadyThere = await adapter.findExternalPost(idempotencyKey);

  if (alreadyThere !== null) {
    await markPublished(deps.db, job.id, alreadyThere.externalPostId, alreadyThere.externalUrl);

    return {
      jobId: job.id,
      status: 'RECOVERED',
      externalPostId: alreadyThere.externalPostId,
      externalUrl: alreadyThere.externalUrl,
      // Recovery is what an operator needs to see: this post went out on an
      // earlier attempt by a worker that then died, and we found it rather than
      // making a second. `recovered` is the flag; the status says it too.
      recovered: true,
    };
  }

  try {
    const result = await adapter.publish({
      idempotencyKey,
      content: job.platformContent,
      mediaKey: job.mediaKey,
    });

    await markPublished(deps.db, job.id, result.externalPostId, result.externalUrl);

    return {
      jobId: job.id,
      status: 'PUBLISHED',
      externalPostId: result.externalPostId,
      externalUrl: result.externalUrl,
      recovered: false,
    };
  } catch (error) {
    const reason = describePublishError(error);
    const attempts = job.attempts;
    const exhausted = attempts >= job.maxAttempts;

    await deps.db
      .update(publishJobs)
      .set({
        // Terminal only when there is nothing left to try. A transient failure
        // leaves the row claimable so a retry can pick it up.
        status: exhausted ? 'FAILED' : 'PENDING',
        error: reason,
        workerId: null,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.id, job.id));

    return {
      jobId: job.id,
      status: exhausted ? 'FAILED' : 'RETRY',
      externalPostId: null,
      externalUrl: null,
      recovered: false,
      error: reason,
    };
  }
}

/**
 * Records the external id in ONE transaction with the terminal status.
 *
 * One transaction because the two must not disagree: a row that is PUBLISHED
 * with no id is a post nobody can find, and an id with no PUBLISHED status is a
 * post that will be published again.
 */
async function markPublished(
  db: Database,
  jobId: string,
  externalPostId: string,
  externalUrl: string | null,
): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      status: 'PUBLISHED',
      externalPostId,
      externalUrl,
      publishedAt: new Date(),
      error: null,
      workerId: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(publishJobs.id, jobId));
}

/** Terminal failures: a message that says what to do, not what happened. */
export function describePublishError(error: unknown): string {
  if (error instanceof PublishError) {
    switch (error.classification) {
      case 'AUTH_EXPIRED':
        return 'the connected account needs to be reconnected';
      case 'REJECTED':
        return `the platform rejected the post: ${error.message}`;
      case 'TRANSIENT':
        return `temporary platform failure: ${error.message}`;
      case 'PERMANENT':
        return error.message;
    }
  }

  return error instanceof Error ? error.message.slice(0, 500) : 'unknown publish failure';
}

/**
 * Publishing jobs whose lease expired.
 *
 * The same shape as the generation reaper, for the same reason: a worker killed
 * mid-publish leaves a row claiming to be in progress with nobody behind it.
 */
export async function findStalePublishJobs(db: Database, limit = 50): Promise<PublishJobRow[]> {
  return db
    .select()
    .from(publishJobs)
    .where(
      and(
        eq(publishJobs.status, 'PUBLISHING'),
        or(isNull(publishJobs.lockedUntil), lte(publishJobs.lockedUntil, new Date())),
      ),
    )
    .limit(limit);
}

/** The validation for a schedule request. */
export const scheduleSchema = z.object({
  scheduledAt: z.coerce.date(),
  accountIds: z.array(z.string().uuid()).min(1).max(10),
});

export type ScheduleInput = z.infer<typeof scheduleSchema>;

/** Builds the platform-specific text for a post, at schedule time. */
export function platformContentFor(
  platform: SocialPlatform,
  caption: string,
  hashtags: readonly string[],
): FormatResult {
  return formatForPlatform(platform, caption, hashtags);
}
