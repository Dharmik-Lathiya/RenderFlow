import { eq } from 'drizzle-orm';

import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  type Moderator,
} from '@renderflow/ai';
import { processJob, runJob } from '@renderflow/jobs';
import { assets, generationJobs, outboxEvents, posts } from '@renderflow/db';

import { ModerationService } from '../../apps/api/src/jobs/moderation.service';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { TEST_PASSWORD, uniqueEmail, walletOf } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import { fakeStorage } from './helpers/fake-storage';
import { seedFestival, templateIdFor } from './helpers/festival-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Festival marketing (Phase 11).
 *
 * The API half proves the credit-critical creation contract: a post, a
 * reservation and an outbox event in one transaction, with a replay that does
 * not leave a second post behind. The runner half proves the parts that only
 * exist in the festival pipeline - the template snapshot, the copy checkpoint and
 * the poster/reel assets attached to the post the user is looking at.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

const OCCASION = 'DIWALI' as const;

describe('festival marketing (Phase 11)', () => {
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
    await seedFestival(db);
    app.app.get(ModerationService).setModerator({
      name: 'allow-all',
      moderate: async () => ({ allowed: true, source: 'test' }),
    } satisfies Moderator);
  });

  async function account(prefix: string): Promise<Account> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: TEST_PASSWORD, name: prefix });

    if (res.status !== 201) {
      throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
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
  });

  async function campaignFor(acct: Account): Promise<string> {
    const brand = await asUser(acct)
      .post('/api/v1/brands')
      .send({
        workspaceId: acct.workspaceId,
        name: 'Denny Bakery',
        industry: 'food',
        tone: 'warm',
        audience: 'local families',
        colors: ['#E67E22'],
        languages: ['en', 'hi'],
      });
    expect(brand.status).toBe(201);

    const campaign = await asUser(acct)
      .post('/api/v1/campaigns')
      .send({ brandId: brand.body.id as string, goal: 'Diwali offer' });
    expect(campaign.status).toBe(201);

    return campaign.body.id as string;
  }

  function festivalBody(overrides: Record<string, unknown> = {}) {
    return {
      occasionId: OCCASION,
      templateId: templateIdFor(OCCASION),
      offerText: '20% off all mithai this Diwali',
      ctaText: 'Order before Friday',
      language: 'both',
      includeReel: false,
      ...overrides,
    };
  }

  function createFestival(acct: Account, campaignId: string, body: object, key?: string) {
    const request = asUser(acct).post(`/api/v1/campaigns/${campaignId}/festival`).send(body);
    return key === undefined ? request : request.set('Idempotency-Key', key);
  }

  describe('catalogue and estimate', () => {
    it('lists the seeded occasions', async () => {
      const acct = await account('fest-cat');
      const res = await asUser(acct).get('/api/v1/festival/occasions');

      expect(res.status).toBe(200);
      expect(res.body.map((row: { id: string }) => row.id)).toContain(OCCASION);
    });

    it('lists templates for an occasion only', async () => {
      const acct = await account('fest-cat');
      const res = await asUser(acct).get('/api/v1/festival/templates?occasion=DIWALI');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ occasionId: 'DIWALI', id: templateIdFor(OCCASION) });
    });

    it('quotes the bundle without double-counting the poster', async () => {
      const acct = await account('fest-cat');
      const res = await asUser(acct).get('/api/v1/festival/estimate?includeReel=true');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        poster: 6,
        reelAddOn: 30,
        total: 36,
        includeReel: true,
      });
    });
  });

  describe('POST /campaigns/:id/festival', () => {
    it('creates the post, reservation and outbox event in one transaction', async () => {
      const acct = await account('fest-create');
      const campaignId = await campaignFor(acct);

      const res = await createFestival(acct, campaignId, festivalBody());

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ creditsReserved: 6, replayed: false });
      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 44, reserved: 6 });

      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, res.body.postId as string));
      expect(post).toMatchObject({ campaignId, type: 'POSTER', status: 'GENERATING' });

      const [job] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, res.body.jobId as string));
      expect(job).toMatchObject({
        postId: res.body.postId,
        kind: 'FESTIVAL_IMAGE',
        creditsReserved: 6,
      });
      expect(job?.payload).toMatchObject({
        occasionId: OCCASION,
        template: { id: templateIdFor(OCCASION) },
      });

      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, res.body.jobId as string));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'job.created', processedAt: null });
    });

    it('replays an Idempotency-Key without creating an orphan post', async () => {
      const acct = await account('fest-replay');
      const campaignId = await campaignFor(acct);

      const first = await createFestival(acct, campaignId, festivalBody(), 'festival-key-1');
      const second = await createFestival(acct, campaignId, festivalBody(), 'festival-key-1');

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({
        jobId: first.body.jobId,
        postId: first.body.postId,
        replayed: true,
      });

      const allPosts = await db.select().from(posts).where(eq(posts.campaignId, campaignId));
      expect(allPosts).toHaveLength(1);
      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 44, reserved: 6 });
    });

    it('refuses a campaign in another workspace', async () => {
      const owner = await account('fest-owner');
      const intruder = await account('fest-intruder');
      const campaignId = await campaignFor(owner);

      const res = await createFestival(intruder, campaignId, festivalBody());

      expect(res.status).toBe(403);
      await expect(walletOf(db, intruder.userId)).resolves.toEqual({
        available: 50,
        reserved: 0,
      });
    });

    it('moderates before reserving credits', async () => {
      const acct = await account('fest-mod');
      const campaignId = await campaignFor(acct);

      app.app.get(ModerationService).setModerator({
        name: 'refuse-all',
        moderate: async () => ({ allowed: false, reason: 'refused', source: 'test' }),
      });

      const res = await createFestival(acct, campaignId, festivalBody());

      expect(res.status).toBe(422);
      await expect(walletOf(db, acct.userId)).resolves.toEqual({
        available: 50,
        reserved: 0,
      });
      await expect(
        db.select().from(generationJobs).where(eq(generationJobs.userId, acct.userId)),
      ).resolves.toHaveLength(0);
    });
  });

  describe('poster pipeline', () => {
    async function deps(failStage?: string) {
      const shared = {
        ...(failStage === undefined ? {} : { failStage }),
        sequence: { count: 0 },
      };
      return {
        db,
        storage: fakeStorage(),
        providers: {
          text: new MockTextProvider(shared),
          image: new MockImageProvider(shared),
          tts: new MockTtsProvider(shared),
          renderer: new MockRendererProvider(shared),
        },
        brand: {
          name: 'Denny Bakery',
          tone: 'warm',
          audience: 'local families',
          colors: ['#E67E22'],
          languages: ['en', 'hi'],
        },
      };
    }

    it('runs PLAN, SCRIPT and IMAGE and attaches the poster to the post', async () => {
      const acct = await account('fest-run');
      const campaignId = await campaignFor(acct);
      const created = await createFestival(acct, campaignId, festivalBody());

      const result = await runJob(await deps(), created.body.jobId as string);
      expect(result).toMatchObject({
        outcome: 'COMPLETED',
        stagesRun: ['PLAN', 'SCRIPT', 'IMAGE'],
      });

      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, created.body.postId as string));
      expect(post).toMatchObject({ status: 'READY' });
      expect(post?.caption).toContain('mithai');
      expect(post?.hashtags).toContain('#diwali');

      const postAssets = await db
        .select()
        .from(assets)
        .where(eq(assets.postId, created.body.postId as string));
      expect(postAssets).toHaveLength(1);
      expect(postAssets[0]).toMatchObject({ type: 'IMAGE', mime: 'image/png' });
      expect(postAssets[0]?.storageKey).toContain(
        `generated/festival/${created.body.jobId}/poster`,
      );

      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 44, reserved: 0 });

      const [job] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, created.body.jobId as string));
      expect(job).toMatchObject({ status: 'COMPLETED', stage: 'DONE', captured: 1, refunded: 0 });
    });

    it('adds the reel and charges the bundle price', async () => {
      const acct = await account('fest-reel');
      const campaignId = await campaignFor(acct);
      const created = await createFestival(acct, campaignId, festivalBody({ includeReel: true }));

      expect(created.body).toMatchObject({ creditsReserved: 36 });
      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 14, reserved: 36 });

      const result = await runJob(await deps(), created.body.jobId as string);
      expect(result).toMatchObject({
        outcome: 'COMPLETED',
        stagesRun: ['PLAN', 'SCRIPT', 'IMAGE', 'RENDER'],
      });

      const postAssets = await db
        .select()
        .from(assets)
        .where(eq(assets.postId, created.body.postId as string));
      expect(postAssets.map((asset) => asset.type).sort()).toEqual(['IMAGE', 'VIDEO']);
      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 14, reserved: 0 });
    });

    it('refunds a failed copy stage and closes the post', async () => {
      const acct = await account('fest-fail');
      const campaignId = await campaignFor(acct);
      const created = await createFestival(acct, campaignId, festivalBody());

      const settled = await processJob(await deps('COPY_FILL'), created.body.jobId as string);
      expect(settled.outcome).toBe('FAILED');

      const [post] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, created.body.postId as string));
      expect(post).toMatchObject({ status: 'FAILED' });
      await expect(walletOf(db, acct.userId)).resolves.toEqual({ available: 50, reserved: 0 });
    });
  });
});
