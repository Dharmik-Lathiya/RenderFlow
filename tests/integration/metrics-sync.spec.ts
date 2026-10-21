import { eq } from 'drizzle-orm';
import {
  brands,
  campaigns,
  postMetrics,
  posts,
  publishJobs,
  socialAccounts,
  workspaceMembers,
  workspaces,
} from '@renderflow/db';
import {
  MetricsSyncProcessor,
  MockMetricsAdapter,
  UnsupportedMetricsAdapter,
  bucketFor,
  createTokenCipher,
  type MetricsAdapter,
  type SocialPlatform,
} from '@renderflow/social';

import { createUserWithBonus } from './helpers/auth-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * The metrics sync against a real database (PROJECT.md Phase 9).
 *
 * The properties that only exist against Postgres:
 *
 *  - the due query's lateral join (one row per publish job, not per snapshot);
 *  - the unique `(publish_job_id, fetched_at)` index making a second run in the
 *    same hour an update rather than a duplicate;
 *  - a re-run after the refresh window creating a SECOND row, so the history the
 *    dashboard charts is real history.
 */

const cipher = createTokenCipher(Buffer.alloc(32, 13));
const HOUR = 3_600_000;
const NOW = new Date('2026-06-01T12:34:56Z');

describe('MetricsSyncProcessor', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  interface Seeded {
    userId: string;
    workspaceId: string;
    postId: string;
    publishJobId: string;
  }

  async function seed(input?: {
    platform?: SocialPlatform;
    publishedAt?: Date;
    externalPostId?: string | null;
    publishStatus?: 'PUBLISHED' | 'SCHEDULED';
  }): Promise<Seeded> {
    const platform = input?.platform ?? 'instagram';
    const user = await createUserWithBonus(db, { bonus: 50 });
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Acme', ownerId: user.id })
      .returning({ id: workspaces.id });

    if (workspace === undefined) {
      throw new Error('no workspace');
    }

    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: user.id, role: 'OWNER' });

    const [brand] = await db
      .insert(brands)
      .values({
        workspaceId: workspace.id,
        name: 'Acme',
        industry: 'retail',
        colors: [],
        languages: ['en'],
      })
      .returning({ id: brands.id });

    const [campaign] = await db
      .insert(campaigns)
      .values({
        brandId: only(brand).id,
        goal: 'launch',
        status: 'ACTIVE',
        createdBy: user.id,
      })
      .returning({ id: campaigns.id });

    const [post] = await db
      .insert(posts)
      .values({
        campaignId: only(campaign).id,
        brandId: only(brand).id,
        type: 'REEL',
        caption: 'A reel',
        status: input?.publishStatus === 'SCHEDULED' ? 'APPROVED' : 'PUBLISHED',
      })
      .returning({ id: posts.id });

    const [account] = await db
      .insert(socialAccounts)
      .values({
        workspaceId: workspace.id,
        platform,
        externalAccountId: `ext-${platform}`,
        token: cipher.encrypt(JSON.stringify({ accessToken: 'access-token' })),
        connectedBy: user.id,
      })
      .returning({ id: socialAccounts.id });

    const publishedAt = input?.publishedAt ?? new Date(NOW.getTime() - 2 * HOUR);

    const [job] = await db
      .insert(publishJobs)
      .values({
        postId: only(post).id,
        socialAccountId: only(account).id,
        status: input?.publishStatus ?? 'PUBLISHED',
        scheduledFor: publishedAt,
        platformContent: 'A reel',
        externalPostId: input?.externalPostId === undefined ? 'ext-post-1' : input.externalPostId,
        publishedAt: input?.publishStatus === 'SCHEDULED' ? null : publishedAt,
        externalUrl: 'https://example.com/p/1',
      })
      .returning({ id: publishJobs.id });

    return {
      userId: user.id,
      workspaceId: workspace.id,
      postId: only(post).id,
      publishJobId: only(job).id,
    };
  }

  function only<T>(row: T | undefined): T {
    if (row === undefined) {
      throw new Error('expected one row');
    }
    return row;
  }

  function processor(
    adapter: MetricsAdapter = new MockMetricsAdapter({ platform: 'instagram' }),
    overrides: Partial<ConstructorParameters<typeof MetricsSyncProcessor>[0]> = {},
  ) {
    return new MetricsSyncProcessor({
      db,
      decrypt: (ciphertext) => {
        const decoded = JSON.parse(cipher.decrypt(ciphertext)) as { accessToken: string };
        return decoded.accessToken;
      },
      adapterFor: () => adapter,
      now: () => NOW,
      ...overrides,
    });
  }

  async function snapshots(publishJobId: string) {
    return db
      .select()
      .from(postMetrics)
      .where(eq(postMetrics.publishJobId, publishJobId))
      .orderBy(postMetrics.fetchedAt);
  }

  it('writes one snapshot for a due published post', async () => {
    const ids = await seed();

    const outcomes = await processor().runOnce();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'SYNCED', publishJobId: ids.publishJobId });

    const rows = await snapshots(ids.publishJobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fetchedAt.toISOString()).toBe(bucketFor(NOW).toISOString());
    expect(rows[0]?.reach).toBeGreaterThan(0);
  });

  it('updates the same hourly bucket instead of duplicating it', async () => {
    const ids = await seed();

    await processor().runOnce();

    // A second pass thirty minutes later: same bucket, same idempotency key.
    const later = new Date(NOW.getTime() + 30 * 60_000);
    await processor(undefined, { now: () => later }).runOnce();

    const rows = await snapshots(ids.publishJobId);
    expect(rows).toHaveLength(1);
  });

  it('keeps older buckets as history on a later refresh', async () => {
    const ids = await seed();

    await processor().runOnce();

    // Seven hours later the snapshot is stale and is refreshed into a NEW bucket,
    // which is what the daily series reads.
    const later = new Date(NOW.getTime() + 7 * HOUR);
    await processor(undefined, { now: () => later }).runOnce();

    const rows = await snapshots(ids.publishJobId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.fetchedAt.toISOString()).toBe(bucketFor(later).toISOString());
  });

  it('waits before asking about a post that was just published', async () => {
    const ids = await seed({ publishedAt: new Date(NOW.getTime() - 60_000) });

    const outcomes = await processor().runOnce();

    expect(outcomes).toHaveLength(0);
    expect(await snapshots(ids.publishJobId)).toHaveLength(0);
  });

  it('ignores posts that are not published or have no external id', async () => {
    const scheduled = await seed({ publishStatus: 'SCHEDULED' });
    const noExternal = await seed({ externalPostId: null });

    const outcomes = await processor().runOnce();

    expect(outcomes).toHaveLength(0);
    expect(await snapshots(scheduled.publishJobId)).toHaveLength(0);
    expect(await snapshots(noExternal.publishJobId)).toHaveLength(0);
  });

  it('reports a platform without metrics as skipped, and writes no fabricated zeroes', async () => {
    const ids = await seed({ platform: 'linkedin' });

    const outcomes = await processor(new UnsupportedMetricsAdapter('linkedin')).runOnce();

    expect(outcomes[0]).toMatchObject({ status: 'SKIPPED', reason: 'platform exposes no metrics' });
    expect(await snapshots(ids.publishJobId)).toHaveLength(0);
  });

  it('leaves the row unsynced after a transient failure, and retries next pass', async () => {
    const ids = await seed();
    const adapter = new MockMetricsAdapter({ platform: 'instagram', failTimes: 1 });

    const first = await processor(adapter).runOnce();
    expect(first[0]).toMatchObject({ status: 'FAILED' });
    expect(await snapshots(ids.publishJobId)).toHaveLength(0);

    const second = await processor(adapter).runOnce();
    expect(second[0]).toMatchObject({ status: 'SYNCED' });
    expect(await snapshots(ids.publishJobId)).toHaveLength(1);
  });

  it('clamps impossible platform numbers rather than violating a CHECK constraint', async () => {
    const ids = await seed();
    const hostile: MetricsAdapter = {
      platform: 'instagram',
      supported: true,
      fetchMetrics: async () => ({ likes: -5, comments: 3.9, reach: Number.NaN, clicks: 1 }),
    };

    const outcomes = await processor(hostile).runOnce();

    expect(outcomes[0]).toMatchObject({ status: 'SYNCED' });
    const rows = await snapshots(ids.publishJobId);
    expect(rows[0]).toMatchObject({ likes: 0, comments: 3, reach: 0, clicks: 1 });
  });
});
