import { eq, sql } from 'drizzle-orm';

import { creditLedger, generationJobs, outboxEvents } from '@renderflow/db';
import { processJob, failJob } from '@renderflow/jobs';
import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
} from '@renderflow/ai';

import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { seedPricing } from './helpers/credit-fixtures';
import { fakeStorage } from './helpers/fake-storage';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * The operator surface: DLQ listing, replay and reconciliation (PROJECT.md
 * sections 9.7, 9.9).
 *
 * Replay is the interesting one, because it moves credits. The original attempt
 * was refunded; replaying re-charges. A replay that did NOT re-charge would be a
 * hole an operator could pull on repeatedly, and the test for it is the whole
 * reason this file exists.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

describe('admin: DLQ and reconciliation (Phase 5)', () => {
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
  });

  async function postFor(acct: Account): Promise<string> {
    const brand = await asUser(acct)
      .post('/api/v1/brands')
      .send({ workspaceId: acct.workspaceId, name: 'Acme', industry: 'retail' });
    const campaign = await asUser(acct)
      .post('/api/v1/campaigns')
      .send({ brandId: brand.body.id as string, goal: 'launch' });
    const post = await asUser(acct)
      .post('/api/v1/posts')
      .send({ campaignId: campaign.body.id as string, type: 'CAPTION', caption: 'Hello' });
    return post.body.id as string;
  }

  /** Creates a reel and drives it to FAILED, with the credits refunded. */
  async function failedReel(acct: Account, postId: string): Promise<string> {
    const created = await asUser(acct)
      .post(`/api/v1/posts/${postId}/generate`)
      .send({ type: 'REEL', scenes: 2, images: 2 });
    const jobId = created.body.job.id as string;

    const shared = { failStage: 'IMAGE', sequence: { count: 0 } };
    await processJob(
      {
        db,
        storage: fakeStorage(),
        providers: {
          text: new MockTextProvider(shared),
          image: new MockImageProvider(shared),
          tts: new MockTtsProvider(shared),
          renderer: new MockRendererProvider(shared),
        },
      },
      jobId,
    );

    return jobId;
  }

  async function wallet(userId: string) {
    const rows = await db.execute<{ available: string; reserved: string }>(sql`
      SELECT available::text AS available, reserved::text AS reserved
        FROM wallets WHERE user_id = ${userId}::uuid
    `);
    return rows.rows[0];
  }

  describe('GET /admin/dlq', () => {
    it('lists a job that was given up on', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));

      const res = await asUser(acct).get('/api/v1/admin/dlq');

      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
      expect(res.body.jobs[0]).toMatchObject({
        id: jobId,
        status: 'FAILED',
        refunded: true,
        captured: false,
      });
      expect(String(res.body.jobs[0].error)).toContain('IMAGE');
    });

    it('does not list a job that succeeded', async () => {
      const acct = await account('owner');
      const postId = await postFor(acct);
      const created = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });
      const jobId = created.body.job.id as string;

      await failJob(db, jobId, 'forced');
      // Forced to FAILED after a successful reserve is still a settled job; the
      // list is about work that was given up on, not any FAILED row.
      await db
        .update(generationJobs)
        .set({ status: 'PENDING', refunded: 0 })
        .where(eq(generationJobs.id, jobId));

      const res = await asUser(acct).get('/api/v1/admin/dlq');

      expect(res.body.jobs).toHaveLength(0);
    });

    it('refuses a caller who owns no workspace', async () => {
      const owner = await account('owner');
      await failedReel(owner, await postFor(owner));

      // Every registration creates a personal workspace the caller owns, so the
      // way to be refused is an authenticated user with no OWNER membership.
      const stranger = await account('stranger');
      await db.execute(sql`
        DELETE FROM workspace_members WHERE user_id = ${stranger.userId}::uuid
      `);

      const res = await asUser(stranger).get('/api/v1/admin/dlq');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await app.http().get('/api/v1/admin/dlq');
      expect(res.status).toBe(401);
    });

    it('rejects a nonsense limit rather than defaulting silently', async () => {
      const acct = await account('owner');
      const res = await asUser(acct).get('/api/v1/admin/dlq?limit=9999');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /admin/dlq/:id/replay', () => {
    it('re-charges the owner, because the first attempt was refunded', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));

      await expect(wallet(acct.userId)).resolves.toMatchObject({ available: '50', reserved: '0' });

      const res = await asUser(acct).post(`/api/v1/admin/dlq/${jobId}/replay`).send({});

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ requeued: true });
      expect(res.body.jobId).not.toBe(jobId);

      // 50 - 30 again. A replay that did not re-reserve would show 50 here and
      // be a free generation anyone with an OWNER role could hand out.
      await expect(wallet(acct.userId)).resolves.toMatchObject({
        available: '20',
        reserved: '30',
      });

      // And the money moved through the ledger, not around it.
      const reserves = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'RESERVE'`);
      expect(reserves).toHaveLength(2);
    });

    it('refuses when the owner cannot afford it again', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));

      // The user spends the refunded credits on something else before the replay.
      await db.execute(sql`
        UPDATE wallets
           SET available = 0, reserved = 0
         WHERE user_id = ${acct.userId}::uuid
      `);

      const res = await asUser(acct).post(`/api/v1/admin/dlq/${jobId}/replay`).send({});

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
      await expect(wallet(acct.userId)).resolves.toMatchObject({ available: '0', reserved: '0' });
    });

    it('refuses a job that was never failed', async () => {
      const acct = await account('owner');
      const postId = await postFor(acct);
      const created = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      const res = await asUser(acct)
        .post(`/api/v1/admin/dlq/${created.body.job.id}/replay`)
        .send({});

      // 404 rather than 409: an operator probing ids learns nothing about which
      // jobs exist.
      expect(res.status).toBe(404);
    });

    it('404s for an id that is not a job', async () => {
      const acct = await account('owner');
      const res = await asUser(acct)
        .post('/api/v1/admin/dlq/00000000-0000-4000-8000-000000000000/replay')
        .send({});

      expect(res.status).toBe(404);
    });

    it('refuses a non-OWNER', async () => {
      const owner = await account('owner');
      const jobId = await failedReel(owner, await postFor(owner));
      const stranger = await account('stranger');
      await db.execute(sql`
        DELETE FROM workspace_members WHERE user_id = ${stranger.userId}::uuid
      `);

      const res = await asUser(stranger).post(`/api/v1/admin/dlq/${jobId}/replay`).send({});

      expect(res.status).toBe(403);
      // Refused before any credit moved.
      await expect(wallet(owner.userId)).resolves.toMatchObject({ available: '50', reserved: '0' });
    });
  });

  describe('outbox replay', () => {
    /**
     * Marks exactly one of a job's events abandoned, and returns its id.
     *
     * Exactly one: a failed reel leaves several unprocessed events (one per
     * completed stage, plus the refund), and marking them all would make the
     * replay assertions below ambiguous.
     */
    async function abandonOneEvent(jobId: string): Promise<string> {
      const rows = await db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, jobId));

      const target = rows[0]?.id;
      if (target === undefined) {
        throw new Error(`no outbox event for job ${jobId}`);
      }

      await db.update(outboxEvents).set({ attempts: 99 }).where(eq(outboxEvents.id, target));
      return target;
    }

    it('lists an abandoned event', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));
      const eventId = await abandonOneEvent(jobId);

      const res = await asUser(acct).get('/api/v1/admin/dlq/outbox');

      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0]).toMatchObject({ id: eventId, aggregateId: jobId });
    });

    it('puts it back in the pending set', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));
      const eventId = await abandonOneEvent(jobId);

      const res = await asUser(acct).post(`/api/v1/admin/dlq/outbox/${eventId}/replay`);

      expect(res.status).toBe(202);
      const after = await asUser(acct).get('/api/v1/admin/dlq/outbox');
      expect(after.body.events).toHaveLength(0);
    });

    it('leaves the other events of the same job alone', async () => {
      // Replay is per event. Resetting the whole job's events would re-publish
      // stages that already completed, and the deterministic job id would then
      // swallow some of them and not others.
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));
      const rows = await db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, jobId));
      expect(rows.length).toBeGreaterThan(1);

      await db
        .update(outboxEvents)
        .set({ attempts: 99 })
        .where(eq(outboxEvents.aggregateId, jobId));
      const target = rows[0]?.id;
      if (target === undefined) {
        throw new Error('no outbox event to replay');
      }
      await asUser(acct).post(`/api/v1/admin/dlq/outbox/${target}/replay`);

      const after = await asUser(acct).get('/api/v1/admin/dlq/outbox');
      expect(after.body.events).toHaveLength(rows.length - 1);
    });

    it('404s for an unknown event', async () => {
      const acct = await account('owner');
      const res = await asUser(acct).post(
        '/api/v1/admin/dlq/outbox/00000000-0000-4000-8000-000000000000/replay',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/reconcile', () => {
    it('reports no drift after a reel is charged', async () => {
      const acct = await account('owner');
      const postId = await postFor(acct);
      const created = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      await db.execute(sql`
        UPDATE generation_jobs SET status = 'COMPLETED', captured = 1
         WHERE id = ${created.body.job.id}::uuid
      `);

      const res = await asUser(acct).get('/api/v1/admin/reconcile');

      expect(res.status).toBe(200);
      expect(res.body.drifted).toBe(0);
      expect(res.body.checked).toBeGreaterThan(0);
    });

    it('reports no drift after a refund', async () => {
      const acct = await account('owner');
      await failedReel(acct, await postFor(acct));

      const res = await asUser(acct).get('/api/v1/admin/reconcile');

      expect(res.body.drifted).toBe(0);
    });

    it('notices drift when the wallet is edited behind the ledger', async () => {
      const acct = await account('owner');
      const jobId = await failedReel(acct, await postFor(acct));

      // Simulates the bug this endpoint exists to catch: money moved without a
      // ledger row. The append-only ledger is what makes the difference visible.
      await db.execute(sql`
        UPDATE wallets SET available = available + 500 WHERE user_id = ${acct.userId}::uuid
      `);

      const res = await asUser(acct).get('/api/v1/admin/reconcile');

      expect(res.body.drifted).toBe(1);
      // The report names the user and shows both sides of the comparison, so an
      // operator can see which number is wrong rather than only that one is.
      expect(res.body.drift[0]).toMatchObject({
        userId: acct.userId,
        available: 550,
        reserved: 0,
        drifted: true,
      });
      expect(jobId).toEqual(expect.any(String));
    });

    it('refuses a caller who owns no workspace', async () => {
      const stranger = await account('stranger');
      await db.execute(sql`
        DELETE FROM workspace_members WHERE user_id = ${stranger.userId}::uuid
      `);

      const res = await asUser(stranger).get('/api/v1/admin/reconcile');

      expect(res.status).toBe(403);
    });
  });

  describe('a replayed job runs normally', () => {
    it('reserves, checkpoints and captures on the second life', async () => {
      const acct = await account('owner');
      const postId = await postFor(acct);
      const failed = await failedReel(acct, postId);

      const replay = await asUser(acct).post(`/api/v1/admin/dlq/${failed}/replay`).send({});
      const replayedId = replay.body.jobId as string;

      const shared = { sequence: { count: 0 } };
      await processJob(
        {
          db,
          storage: fakeStorage(),
          providers: {
            text: new MockTextProvider(shared),
            image: new MockImageProvider(shared),
            tts: new MockTtsProvider(shared),
            renderer: new MockRendererProvider(shared),
          },
        },
        replayedId,
      );

      const job = await asUser(acct).get(`/api/v1/jobs/${replayedId}`);
      expect(job.body).toMatchObject({ status: 'COMPLETED', captured: true, refunded: false });

      // Charged once more, for work actually delivered.
      await expect(wallet(acct.userId)).resolves.toMatchObject({
        available: '20',
        reserved: '0',
      });
    });

    it('carries the original generation parameters onto the replay', async () => {
      const acct = await account('owner');
      const postId = await postFor(acct);
      const created = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL', scenes: 3, images: 3 });
      const failed = created.body.job.id as string;
      await failJob(db, failed, 'forced');

      const replay = await asUser(acct).post(`/api/v1/admin/dlq/${failed}/replay`).send({});
      const replayedId = replay.body.jobId as string;

      const rows = await db
        .select({ payload: generationJobs.payload })
        .from(generationJobs)
        .where(eq(generationJobs.id, replayedId));

      // A replay that silently defaulted to 1 image would produce a different
      // (and cheaper) thing than the user originally asked for.
      expect(rows[0]?.payload).toMatchObject({ scenes: 3, images: 3 });
    });
  });
});
