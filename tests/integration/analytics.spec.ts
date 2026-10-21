import { eq } from 'drizzle-orm';
import { postMetrics, publishJobs, socialAccounts } from '@renderflow/db';

import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Analytics reads and the calendar (PROJECT.md sections 10 and 12 Phase 9).
 *
 * The interesting assertions are the ones about which snapshot a read picks:
 * the LATEST per publication, and one per publication per DAY in the series. A
 * naive SUM over `post_metrics` passes every type check and reports six times
 * the real engagement after a worker has run six times.
 *
 * Tenancy is asserted too. Analytics is the one place where the correct answer
 * is "all of a workspace's numbers", which makes it exactly the place where a
 * missing scope check leaks another customer's performance.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

describe('analytics (Phase 9)', () => {
  let db: TestDb;
  let app: TestApp;

  beforeAll(async () => {
    db = await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
  });

  async function account(prefix: string): Promise<Account> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: TEST_PASSWORD, name: prefix });

    if (res.status !== 201) {
      throw new Error(`register failed: ${res.status}`);
    }

    const ws = await app
      .http()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${res.body.accessToken as string}`);

    return {
      userId: res.body.user.id as string,
      accessToken: res.body.accessToken as string,
      workspaceId: ws.body[0].id as string,
    };
  }

  const asUser = (acct: Account) => ({
    get: (url: string) => app.http().get(url).set('Authorization', `Bearer ${acct.accessToken}`),
    post: (url: string) => app.http().post(url).set('Authorization', `Bearer ${acct.accessToken}`),
    patch: (url: string) =>
      app.http().patch(url).set('Authorization', `Bearer ${acct.accessToken}`),
    delete: (url: string) =>
      app.http().delete(url).set('Authorization', `Bearer ${acct.accessToken}`),
  });

  interface Seeded {
    brandId: string;
    campaignId: string;
    reelId: string;
    captionId: string;
    accountId: string;
    jobId: string;
  }

  async function seed(acct: Account): Promise<Seeded> {
    const brand = await asUser(acct)
      .post('/api/v1/brands')
      .send({ workspaceId: acct.workspaceId, name: 'Acme', industry: 'retail' });

    const campaign = await asUser(acct)
      .post('/api/v1/campaigns')
      .send({
        brandId: brand.body.id as string,
        goal: 'Spring launch',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      });

    const reel = await asUser(acct)
      .post('/api/v1/posts')
      .send({ campaignId: campaign.body.id as string, type: 'REEL', caption: 'Reel one' });

    const caption = await asUser(acct)
      .post('/api/v1/posts')
      .send({ campaignId: campaign.body.id as string, type: 'CAPTION', caption: 'Caption one' });

    const [accountRow] = await db
      .insert(socialAccounts)
      .values({
        workspaceId: acct.workspaceId,
        // LinkedIn, because it accepts a text-only post: Instagram's rules
        // require media, and this fixture schedules a caption with no asset.
        platform: 'linkedin',
        externalAccountId: 'ext-li-1',
        displayName: 'Acme',
        token: 'not-a-real-token',
        connectedBy: acct.userId,
      })
      .returning({ id: socialAccounts.id });

    if (accountRow === undefined) {
      throw new Error('no social account');
    }

    const publishedAt = new Date('2026-06-10T09:00:00Z');

    const [job] = await db
      .insert(publishJobs)
      .values({
        postId: reel.body.id as string,
        socialAccountId: accountRow.id,
        status: 'PUBLISHED',
        scheduledFor: publishedAt,
        platformContent: 'Reel one',
        externalPostId: 'ext-reel-1',
        externalUrl: 'https://example.com/reel-1',
        publishedAt,
      })
      .returning({ id: publishJobs.id });

    if (job === undefined) {
      throw new Error('no publish job');
    }

    // Three snapshots across two days: two in the same hour-ish bucket day, one
    // the next. The latest of day one and the value of day two are the numbers
    // the endpoint must report.
    await db.insert(postMetrics).values([
      {
        publishJobId: job.id,
        likes: 10,
        comments: 1,
        reach: 100,
        clicks: 2,
        fetchedAt: new Date('2026-06-10T10:00:00Z'),
      },
      {
        publishJobId: job.id,
        likes: 20,
        comments: 2,
        reach: 200,
        clicks: 4,
        fetchedAt: new Date('2026-06-10T14:00:00Z'),
      },
      {
        publishJobId: job.id,
        likes: 30,
        comments: 3,
        reach: 300,
        clicks: 6,
        fetchedAt: new Date('2026-06-11T10:00:00Z'),
      },
    ]);

    return {
      brandId: brand.body.id as string,
      campaignId: campaign.body.id as string,
      reelId: reel.body.id as string,
      captionId: caption.body.id as string,
      accountId: accountRow.id,
      jobId: job.id,
    };
  }

  it('reports the latest snapshot per publication, not the sum of snapshots', async () => {
    const acct = await account('analytics-a');
    const ids = await seed(acct);

    const res = await asUser(acct).get(`/api/v1/analytics/campaigns/${ids.campaignId}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      posts: 2,
      published: 1,
      likes: 30,
      comments: 3,
      reach: 300,
      clicks: 6,
    });
  });

  it('keeps one point per publication per day in the series', async () => {
    const acct = await account('analytics-b');
    const ids = await seed(acct);

    const res = await asUser(acct).get(`/api/v1/analytics/campaigns/${ids.campaignId}`);

    expect(res.body.series).toEqual([
      { date: '2026-06-10', likes: 20, comments: 2, reach: 200, clicks: 4 },
      { date: '2026-06-11', likes: 30, comments: 3, reach: 300, clicks: 6 },
    ]);
  });

  it('includes unpublished posts without inventing metrics for them', async () => {
    const acct = await account('analytics-c');
    const ids = await seed(acct);

    const res = await asUser(acct).get(`/api/v1/analytics/campaigns/${ids.campaignId}`);
    const caption = (res.body.publications as { postId: string; metrics: unknown }[]).find(
      (publication) => publication.postId === ids.captionId,
    );

    expect(caption?.metrics).toBeNull();
  });

  it('suggests the best-performing format from the campaign numbers', async () => {
    const acct = await account('analytics-d');
    const ids = await seed(acct);

    const res = await asUser(acct).get(`/api/v1/analytics/campaigns/${ids.campaignId}`);

    expect(res.body.suggestions[0]).toMatchObject({ type: 'REEL' });
    // The most recent snapshot: (30 likes + 3 comments) / 300 reach.
    expect(res.body.suggestions[0].rationale).toContain('11.0%');
  });

  it('exposes the campaign itself, so the page does not need a second source', async () => {
    const acct = await account('analytics-e');
    const ids = await seed(acct);

    const res = await asUser(acct).get(`/api/v1/campaigns/${ids.campaignId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ids.campaignId,
      goal: 'Spring launch',
      // A campaign starts as a draft; ACTIVE is a status the team sets.
      status: 'DRAFT',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
  });

  it('summarises a workspace by campaign', async () => {
    const acct = await account('analytics-f');
    const ids = await seed(acct);

    const res = await asUser(acct).get(
      `/api/v1/analytics/overview?workspaceId=${acct.workspaceId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ posts: 2, published: 1, likes: 30 });
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0]).toMatchObject({ id: ids.campaignId, brandName: 'Acme' });
  });

  describe('the calendar', () => {
    it('schedules, moves and cancels a post through the workspace view', async () => {
      const acct = await account('analytics-g');
      const ids = await seed(acct);

      await asUser(acct).post(`/api/v1/posts/${ids.captionId}/approve`).send({});

      const first = new Date(Date.now() + 2 * 86_400_000);
      const scheduled = await asUser(acct)
        .post(`/api/v1/posts/${ids.captionId}/schedule`)
        .send({ scheduledAt: first.toISOString(), accountIds: [ids.accountId] });

      expect(scheduled.status).toBe(201);

      const window = (from: Date, to: Date) =>
        `/api/v1/posts?workspaceId=${acct.workspaceId}&from=${from.toISOString()}&to=${to.toISOString()}`;

      const dayOf = (date: Date) =>
        new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
      const endOf = (date: Date) =>
        new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);

      const listed = await asUser(acct).get(window(dayOf(first), endOf(first)));
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ id: ids.captionId, campaignGoal: 'Spring launch' });

      // Drag-to-reschedule: same time on a later day.
      const second = new Date(Date.now() + 3 * 86_400_000);
      const moved = await asUser(acct)
        .patch(`/api/v1/posts/${ids.captionId}/schedule`)
        .send({ scheduledAt: second.toISOString() });

      expect(moved.status).toBe(200);
      expect(moved.body.updated).toBe(1);

      expect((await asUser(acct).get(window(dayOf(first), endOf(first)))).body).toHaveLength(0);
      expect((await asUser(acct).get(window(dayOf(second), endOf(second)))).body).toHaveLength(1);

      // The publish job, not just the post, moved: the publisher claims by time.
      const jobs = await db
        .select({ scheduledFor: publishJobs.scheduledFor })
        .from(publishJobs)
        .where(eq(publishJobs.postId, ids.captionId));
      expect(jobs[0]?.scheduledFor.toISOString()).toBe(second.toISOString());

      const cancelled = await asUser(acct).delete(`/api/v1/posts/${ids.captionId}/schedule`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.cancelled).toBe(1);
      expect((await asUser(acct).get(window(dayOf(second), endOf(second)))).body).toHaveLength(0);
    });

    it('refuses a time in the past', async () => {
      const acct = await account('analytics-h');
      const ids = await seed(acct);

      const res = await asUser(acct)
        .patch(`/api/v1/posts/${ids.captionId}/schedule`)
        .send({ scheduledAt: new Date(Date.now() - 60_000).toISOString() });

      expect(res.status).toBe(400);
    });
  });

  describe('tenancy', () => {
    it('hides another workspace campaign from analytics, detail and the calendar', async () => {
      const owner = await account('analytics-owner');
      const stranger = await account('analytics-stranger');
      const ids = await seed(owner);

      // 403 `WORKSPACE_ACCESS_DENIED`, the same answer every other
      // resource-addressed route gives: the caller learns that they may not act,
      // and nothing about whether the id exists.
      const analytics = await asUser(stranger).get(`/api/v1/analytics/campaigns/${ids.campaignId}`);
      expect(analytics.status).toBe(403);
      expect(analytics.body.code).toBe('WORKSPACE_ACCESS_DENIED');

      const detail = await asUser(stranger).get(`/api/v1/campaigns/${ids.campaignId}`);
      expect(detail.status).toBe(403);

      expect(
        (await asUser(stranger).get(`/api/v1/posts?workspaceId=${owner.workspaceId}`)).status,
      ).toBe(403);
      expect(
        (await asUser(stranger).get(`/api/v1/analytics/overview?workspaceId=${owner.workspaceId}`))
          .status,
      ).toBe(403);
    });

    it('refuses to reschedule a post in another workspace', async () => {
      const owner = await account('analytics-owner-2');
      const stranger = await account('analytics-stranger-2');
      const ids = await seed(owner);

      const res = await asUser(stranger)
        .patch(`/api/v1/posts/${ids.captionId}/schedule`)
        .send({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });

      expect(res.status).toBe(403);
    });
  });
});
