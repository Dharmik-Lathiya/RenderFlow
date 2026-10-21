import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { getDb, type Database } from '@renderflow/db';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { isPostType, suggestNextPosts, type PerformanceRow, type Suggestion } from './suggestions';

/**
 * Analytics reads (PROJECT.md sections 10 and 12 Phase 9).
 *
 * Read-only by design. The numbers are written by `analytics-worker`; this
 * service joins them to posts and campaigns and computes the two things a reader
 * actually asks for: the latest snapshot per publication, and a daily series
 * that does not double-count the hourly snapshots.
 *
 * Every query is scoped through `WorkspaceAccessService` BEFORE it runs, so a
 * caller cannot learn whether a campaign exists outside their workspace.
 */

export interface PlatformMetricsView {
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
  fetchedAt: string;
}

export interface PublicationRow {
  postId: string;
  type: string;
  status: string;
  caption: string | null;
  scheduledAt: string | null;
  publishJobId: string | null;
  publishStatus: string | null;
  platform: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  metrics: PlatformMetricsView | null;
}

export interface AnalyticsTotals {
  posts: number;
  published: number;
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
  /** (likes + comments) / reach, or 0 before any reach is recorded. */
  engagementRate: number;
}

export interface SeriesPoint {
  date: string;
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
}

export interface CampaignAnalytics {
  campaign: {
    id: string;
    brandId: string;
    goal: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
  };
  totals: AnalyticsTotals;
  publications: PublicationRow[];
  series: SeriesPoint[];
  suggestions: Suggestion[];
}

export interface CampaignSummary extends AnalyticsTotals {
  id: string;
  brandName: string;
  goal: string;
  status: string;
}

export interface WorkspaceAnalytics {
  workspaceId: string;
  totals: AnalyticsTotals;
  campaigns: CampaignSummary[];
}

type CampaignRow = {
  id: string;
  brand_id: string;
  goal: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  workspace_id: string;
};

type PublicationSqlRow = {
  post_id: string;
  type: string;
  status: string;
  caption: string | null;
  scheduled_at: string | Date | null;
  publish_job_id: string | null;
  publish_status: string | null;
  platform: string | null;
  external_url: string | null;
  published_at: string | Date | null;
  likes: number | null;
  comments: number | null;
  reach: number | null;
  clicks: number | null;
  fetched_at: string | Date | null;
};

type SeriesSqlRow = {
  day: string;
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
};

type SummarySqlRow = {
  id: string;
  brand_name: string;
  goal: string;
  status: string;
  posts: number;
  published: number;
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
};

@Injectable()
export class AnalyticsService implements OnModuleInit {
  private db!: Database;

  constructor(private readonly access: WorkspaceAccessService) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  async campaign(userId: string, campaignId: string): Promise<CampaignAnalytics> {
    const scoped = await this.access.scope({
      userId,
      resource: 'campaign',
      lookup: async (db) => {
        const rows = await db.execute<CampaignRow>(sql`
          SELECT c.id, c.brand_id, c.goal, c.status,
                 c.start_date::text AS start_date,
                 c.end_date::text AS end_date,
                 b.workspace_id
            FROM campaigns c
            JOIN brands b ON b.id = c.brand_id
           WHERE c.id = ${campaignId}::uuid
           LIMIT 1
        `);

        const row = rows.rows[0];
        return row === undefined ? null : { workspaceId: row.workspace_id, value: row };
      },
    });

    const campaign = scoped.value;
    const publications = await this.publications(campaignId);
    const series = await this.series(campaignId);

    return {
      campaign: {
        id: campaign.id,
        brandId: campaign.brand_id,
        goal: campaign.goal,
        status: campaign.status,
        startDate: campaign.start_date,
        endDate: campaign.end_date,
      },
      totals: totalsOf(publications),
      publications,
      series,
      suggestions: suggestNextPosts(toPerformance(publications)),
    };
  }

  async workspace(userId: string, workspaceId: string): Promise<WorkspaceAnalytics> {
    await this.access.scope({
      userId,
      resource: 'workspace',
      lookup: () => Promise.resolve({ workspaceId, value: null }),
    });

    const result = await this.db.execute<SummarySqlRow>(sql`
      SELECT c.id,
             b.name AS brand_name,
             c.goal,
             c.status,
             COUNT(DISTINCT p.id)::int AS posts,
             COUNT(DISTINCT pj.id) FILTER (WHERE pj.status = 'PUBLISHED')::int AS published,
             COALESCE(SUM(latest.likes), 0)::int AS likes,
             COALESCE(SUM(latest.comments), 0)::int AS comments,
             COALESCE(SUM(latest.reach), 0)::int AS reach,
             COALESCE(SUM(latest.clicks), 0)::int AS clicks
        FROM campaigns c
        JOIN brands b ON b.id = c.brand_id
        LEFT JOIN posts p ON p.campaign_id = c.id
        LEFT JOIN publish_jobs pj ON pj.post_id = p.id AND pj.status = 'PUBLISHED'
        LEFT JOIN LATERAL (
          SELECT pm.likes, pm.comments, pm.reach, pm.clicks
            FROM post_metrics pm
           WHERE pm.publish_job_id = pj.id
           ORDER BY pm.fetched_at DESC
           LIMIT 1
        ) latest ON true
       WHERE b.workspace_id = ${workspaceId}::uuid
       GROUP BY c.id, b.name
       ORDER BY c.created_at DESC
    `);

    const campaigns: CampaignSummary[] = result.rows.map((row) => {
      const totals = {
        posts: row.posts,
        published: row.published,
        likes: row.likes,
        comments: row.comments,
        reach: row.reach,
        clicks: row.clicks,
      };

      return {
        id: row.id,
        brandName: row.brand_name,
        goal: row.goal,
        status: row.status,
        ...totals,
        engagementRate: rateOf(totals),
      };
    });

    return {
      workspaceId,
      totals: campaigns.reduce<AnalyticsTotals>(
        (sum, campaign) => ({
          posts: sum.posts + campaign.posts,
          published: sum.published + campaign.published,
          likes: sum.likes + campaign.likes,
          comments: sum.comments + campaign.comments,
          reach: sum.reach + campaign.reach,
          clicks: sum.clicks + campaign.clicks,
          engagementRate: 0,
        }),
        { posts: 0, published: 0, likes: 0, comments: 0, reach: 0, clicks: 0, engagementRate: 0 },
      ),
      campaigns,
    };
  }

  /**
   * One row per publication with its latest snapshot.
   *
   * The lateral join is the "latest per group" pattern Postgres optimises well,
   * and it keeps the snapshot table append-only: the read picks the newest row
   * rather than the writer mutating one in place.
   */
  private async publications(campaignId: string): Promise<PublicationRow[]> {
    const result = await this.db.execute<PublicationSqlRow>(sql`
      SELECT p.id AS post_id,
             p.type,
             p.status::text AS status,
             p.caption,
             p.scheduled_at,
             pj.id AS publish_job_id,
             pj.status::text AS publish_status,
             pj.external_url,
             pj.published_at,
             sa.platform::text AS platform,
             latest.likes,
             latest.comments,
             latest.reach,
             latest.clicks,
             latest.fetched_at
        FROM posts p
        LEFT JOIN publish_jobs pj ON pj.post_id = p.id
        LEFT JOIN social_accounts sa ON sa.id = pj.social_account_id
        LEFT JOIN LATERAL (
          SELECT pm.likes, pm.comments, pm.reach, pm.clicks, pm.fetched_at
            FROM post_metrics pm
           WHERE pm.publish_job_id = pj.id
           ORDER BY pm.fetched_at DESC
           LIMIT 1
        ) latest ON true
       WHERE p.campaign_id = ${campaignId}::uuid
       ORDER BY p.created_at, pj.created_at
    `);

    return result.rows.map((row) => ({
      postId: row.post_id,
      type: row.type,
      status: row.status,
      caption: row.caption,
      scheduledAt: isoOrNull(row.scheduled_at),
      publishJobId: row.publish_job_id,
      publishStatus: row.publish_status,
      platform: row.platform,
      externalUrl: row.external_url,
      publishedAt: isoOrNull(row.published_at),
      metrics:
        row.fetched_at === null
          ? null
          : {
              likes: row.likes ?? 0,
              comments: row.comments ?? 0,
              reach: row.reach ?? 0,
              clicks: row.clicks ?? 0,
              // Non-null by the check above; `isoOrNull` narrows the shape too.
              fetchedAt: isoOrNull(row.fetched_at) as string,
            },
    }));
  }

  /**
   * Daily totals, one snapshot per publication per day.
   *
   * `DISTINCT ON` is what stops the series from summing every hourly snapshot:
   * without it, a post synced six times today would report six times its likes
   * and the chart would climb simply because the worker ran.
   */
  private async series(campaignId: string): Promise<SeriesPoint[]> {
    const result = await this.db.execute<SeriesSqlRow>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day,
             SUM(likes)::int AS likes,
             SUM(comments)::int AS comments,
             SUM(reach)::int AS reach,
             SUM(clicks)::int AS clicks
        FROM (
          SELECT DISTINCT ON (pm.publish_job_id, date_trunc('day', pm.fetched_at))
                 date_trunc('day', pm.fetched_at) AS day,
                 pm.likes,
                 pm.comments,
                 pm.reach,
                 pm.clicks
            FROM post_metrics pm
            JOIN publish_jobs pj ON pj.id = pm.publish_job_id
            JOIN posts p ON p.id = pj.post_id
           WHERE p.campaign_id = ${campaignId}::uuid
           ORDER BY pm.publish_job_id, date_trunc('day', pm.fetched_at), pm.fetched_at DESC
        ) per_day
       GROUP BY day
       ORDER BY day
    `);

    return result.rows.map((row) => ({
      date: row.day,
      likes: row.likes,
      comments: row.comments,
      reach: row.reach,
      clicks: row.clicks,
    }));
  }
}

export function totalsOf(publications: readonly PublicationRow[]): AnalyticsTotals {
  // A post published to LinkedIn AND Instagram has two publication rows. The
  // post count is distinct; the engagement totals are not, because they came
  // from two different audiences.
  const posts = new Set(publications.map((publication) => publication.postId)).size;
  const published = new Set(
    publications
      .filter((publication) => publication.publishedAt !== null)
      .map((publication) => publication.postId),
  ).size;

  const base = publications.reduce(
    (sum, publication) => ({
      likes: sum.likes + (publication.metrics?.likes ?? 0),
      comments: sum.comments + (publication.metrics?.comments ?? 0),
      reach: sum.reach + (publication.metrics?.reach ?? 0),
      clicks: sum.clicks + (publication.metrics?.clicks ?? 0),
    }),
    { likes: 0, comments: 0, reach: 0, clicks: 0 },
  );

  return { posts, published, ...base, engagementRate: rateOf(base) };
}

function rateOf(totals: { likes: number; comments: number; reach: number }): number {
  return totals.reach <= 0 ? 0 : (totals.likes + totals.comments) / totals.reach;
}

/**
 * A timestamp from a raw query, as an ISO string.
 *
 * `db.execute` hands back the driver's own values, and node-postgres returns
 * `timestamptz` as a Date only when the driver's parsers have not been
 * overridden - which drizzle does. Accepting both shapes here keeps this service
 * from throwing "toISOString is not a function" on a value that is perfectly
 * valid, and the API's JSON contract (an ISO string) stays the same either way.
 */
function isoOrNull(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPerformance(publications: readonly PublicationRow[]): PerformanceRow[] {
  return publications
    .filter((publication) => isPostType(publication.type))
    .map((publication) => ({
      type: publication.type,
      platform: publication.platform,
      likes: publication.metrics?.likes ?? 0,
      comments: publication.metrics?.comments ?? 0,
      reach: publication.metrics?.reach ?? 0,
      clicks: publication.metrics?.clicks ?? 0,
      publishedAt: publication.publishedAt === null ? null : new Date(publication.publishedAt),
    }));
}
