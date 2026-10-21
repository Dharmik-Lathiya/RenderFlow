import { sql } from 'drizzle-orm';

import { postMetrics, type Database } from '@renderflow/db';

import type { SocialPlatform } from './adapter';
import type { MetricsAdapter, PlatformMetrics } from './metrics';

/**
 * The scheduled metrics sync (PROJECT.md section 12 Phase 9).
 *
 * The database is the queue. Like the publisher, this processor asks
 * `publish_jobs` what is due rather than trusting a message in Redis: a sync
 * that only ran when a message arrived would silently stop after a Redis
 * restart, and the dashboard would keep showing last week's numbers without
 * anything appearing broken.
 *
 * Three properties matter:
 *
 *  - **Idempotent.** A snapshot is keyed by `(publish_job_id, hour)`, so running
 *    the sync twice in an hour rewrites one row. The unique index is the
 *    mechanism, not application bookkeeping.
 *  - **Bounded.** One pass takes at most `limit` posts, oldest first. A backlog
 *    drains over several passes instead of holding a transaction open while an
 *    external API answers.
 *  - **No transaction around the call.** The external request happens between
 *    two short statements (the SELECT and the upsert), never inside one.
 */

export type SyncOutcomeStatus = 'SYNCED' | 'SKIPPED' | 'FAILED';

export interface MetricsSyncOutcome {
  publishJobId: string;
  platform: SocialPlatform;
  status: SyncOutcomeStatus;
  metrics?: PlatformMetrics;
  reason?: string;
}

export interface MetricsSyncOptions {
  db: Database;
  /** Decrypts `social_accounts.token`. Injected so this file holds no key. */
  decrypt: (ciphertext: string) => string;
  adapterFor: (platform: SocialPlatform) => MetricsAdapter;
  now?: () => Date;
  /** Do not ask before the post has had time to be seen. Default 5 minutes. */
  firstSyncAfterMs?: number;
  /** Refresh a snapshot older than this. Default 6 hours. */
  refreshAfterMs?: number;
  /** Posts per pass. Default 25. */
  limit?: number;
}

const DEFAULTS = {
  firstSyncAfterMs: 5 * 60_000,
  refreshAfterMs: 6 * 60 * 60_000,
  limit: 25,
};

interface DueRow {
  publish_job_id: string;
  external_post_id: string;
  platform: SocialPlatform;
  token: string;
  published_at: Date;
}

export class MetricsSyncProcessor {
  /**
   * Platforms with no metrics API, remembered for this process.
   *
   * Without it, an unsupported post would be selected on every pass forever,
   * because no snapshot is written for it (writing zeroes would put a fabricated
   * number on a dashboard). Process-local is enough: the cost of forgetting is
   * one extra log line after a restart, not a wrong number.
   */
  private readonly unsupported = new Set<string>();

  constructor(private readonly options: MetricsSyncOptions) {}

  async runOnce(): Promise<MetricsSyncOutcome[]> {
    const now = this.options.now?.() ?? new Date();
    const firstSyncAfterMs = this.options.firstSyncAfterMs ?? DEFAULTS.firstSyncAfterMs;
    const refreshAfterMs = this.options.refreshAfterMs ?? DEFAULTS.refreshAfterMs;
    const limit = this.options.limit ?? DEFAULTS.limit;

    const due = await this.due(now, firstSyncAfterMs, refreshAfterMs, limit);
    const outcomes: MetricsSyncOutcome[] = [];

    for (const row of due) {
      const outcome = await this.syncOne(row, now);
      outcomes.push(outcome);
    }

    return outcomes;
  }

  private async syncOne(row: DueRow, now: Date): Promise<MetricsSyncOutcome> {
    const base = { publishJobId: row.publish_job_id, platform: row.platform };

    if (this.unsupported.has(row.publish_job_id)) {
      return { ...base, status: 'SKIPPED', reason: 'platform exposes no metrics' };
    }

    const adapter = this.options.adapterFor(row.platform);

    if (!adapter.supported) {
      this.unsupported.add(row.publish_job_id);
      return { ...base, status: 'SKIPPED', reason: 'platform exposes no metrics' };
    }

    let accessToken: string;

    try {
      accessToken = this.options.decrypt(row.token);
    } catch (error) {
      // The account cannot be read, so no retry will help. The publisher's
      // reconnect path is the fix; the sync reports it and leaves the row alone.
      return {
        ...base,
        status: 'FAILED',
        reason: `could not decrypt the account token: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const metrics = await adapter.fetchMetrics({
        externalPostId: row.external_post_id,
        accessToken,
        at: now,
        publishedAt: row.published_at,
      });

      // External input is clamped rather than trusted: a negative or fractional
      // value would violate the CHECK constraint and abort the whole pass.
      const safe: PlatformMetrics = {
        likes: nonNegativeInteger(metrics.likes),
        comments: nonNegativeInteger(metrics.comments),
        reach: nonNegativeInteger(metrics.reach),
        clicks: nonNegativeInteger(metrics.clicks),
      };

      await this.upsert(row.publish_job_id, safe, bucketFor(now));
      return { ...base, status: 'SYNCED', metrics: safe };
    } catch (error) {
      return {
        ...base,
        status: 'FAILED',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Writes the snapshot.
   *
   * `ON CONFLICT` on the unique `(publish_job_id, fetched_at)` index: the second
   * run in an hour updates the numbers instead of creating a second row, which
   * is what makes a retried pass safe.
   */
  private async upsert(
    publishJobId: string,
    metrics: PlatformMetrics,
    fetchedAt: Date,
  ): Promise<void> {
    await this.options.db
      .insert(postMetrics)
      .values({
        publishJobId,
        likes: metrics.likes,
        comments: metrics.comments,
        reach: metrics.reach,
        clicks: metrics.clicks,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: [postMetrics.publishJobId, postMetrics.fetchedAt],
        set: {
          likes: metrics.likes,
          comments: metrics.comments,
          reach: metrics.reach,
          clicks: metrics.clicks,
        },
      });
  }

  private async due(
    now: Date,
    firstSyncAfterMs: number,
    refreshAfterMs: number,
    limit: number,
  ): Promise<DueRow[]> {
    const readyAt = new Date(now.getTime() - firstSyncAfterMs);
    const staleAt = new Date(now.getTime() - refreshAfterMs);

    // The lateral join is deliberate: a plain LEFT JOIN + MAX(fetched_at) needs a
    // GROUP BY over every column of the row, and the "latest snapshot" is exactly
    // the kind of thing a second aggregate hides a bug in.
    const result = await this.options.db.execute<DueRow & { [key: string]: unknown }>(sql`
      SELECT pj.id               AS publish_job_id,
             pj.external_post_id,
             pj.published_at,
             sa.platform,
             sa.token
        FROM publish_jobs pj
        JOIN social_accounts sa ON sa.id = pj.social_account_id
        LEFT JOIN LATERAL (
          SELECT pm.fetched_at
            FROM post_metrics pm
           WHERE pm.publish_job_id = pj.id
           ORDER BY pm.fetched_at DESC
           LIMIT 1
        ) latest ON true
       WHERE pj.status = 'PUBLISHED'
         AND pj.external_post_id IS NOT NULL
         AND pj.published_at IS NOT NULL
         AND pj.published_at <= ${readyAt}
         AND (latest.fetched_at IS NULL OR latest.fetched_at <= ${staleAt})
       ORDER BY pj.published_at ASC
       LIMIT ${limit}
    `);

    return result.rows.map((row) => ({
      publish_job_id: row.publish_job_id,
      external_post_id: row.external_post_id,
      platform: row.platform,
      token: row.token,
      published_at: new Date(row.published_at),
    }));
  }
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

/**
 * Floors to the hour, in UTC.
 *
 * The bucket is part of the idempotency key, so it must be derived the same way
 * on every process; `setMinutes(0)` on a local Date would not be.
 */
export function bucketFor(at: Date): Date {
  const hourMs = 3_600_000;
  return new Date(Math.floor(at.getTime() / hourMs) * hourMs);
}
