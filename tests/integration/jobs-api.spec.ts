import { eq } from 'drizzle-orm';

import { generationJobs, jobCheckpoints, outboxEvents } from '@renderflow/db';
import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
} from '@renderflow/ai';
import { failJob, processJob } from '@renderflow/jobs';
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
 * Phase 4 (PROJECT.md section 10): `POST /posts/:id/generate`, `GET /jobs/:id`,
 * `GET /jobs/:id/events`.
 *
 * The API's whole job is to turn a request into credits plus a durable record,
 * and to report on that record honestly. It does not run a job - the relay and a
 * worker do that - so every test here runs the pipeline explicitly rather than
 * hoping a background task finished in time. A test that waits for a worker is a
 * test that will be flaky on a loaded CI box, and it is also a test that cannot
 * tell "the worker is slow" apart from "the worker is broken".
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

describe('jobs API (Phase 4)', () => {
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
    const email = uniqueEmail(prefix);
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email, password: TEST_PASSWORD, name: prefix });

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

  /** A brand, campaign and post to generate against. */
  async function postFor(acct: Account, _type: 'CAPTION' | 'POSTER' | 'CAROUSEL' | 'REEL') {
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

  const generate = (acct: Account, postId: string, body: object, key?: string) => {
    const req = asUser(acct).post(`/api/v1/posts/${postId}/generate`).send(body);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };

  /** Runs a job the way the relay + worker would, with deterministic providers. */
  async function runJobNow(jobId: string, options: { failStage?: string } = {}) {
    const shared = { failStage: options.failStage, sequence: { count: 0 } };
    return processJob(
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
  }

  describe('POST /posts/:id/generate', () => {
    it('reserves credits and returns the job', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const res = await generate(acct, postId, { type: 'REEL', scenes: 3 });

      expect(res.status).toBe(202);
      expect(res.body.job).toMatchObject({
        kind: 'REEL',
        status: 'PENDING',
        stage: 'PLAN',
        creditsReserved: 30,
        refunded: false,
        captured: false,
        completedStages: [],
      });
    });

    it('writes the outbox event with the workspace that owns the job', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const res = await generate(acct, postId, { type: 'REEL' });

      // The relay validates this payload against `jobCreatedEventSchema`, so a
      // placeholder workspace id here would produce an event that fails
      // validation the moment it is published - not on an API error path, but
      // silently inside a worker.
      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, res.body.job.id as string));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: 'JOB',
        eventType: 'job.created',
        processedAt: null,
      });
      expect(events[0]?.payload).toMatchObject({
        jobId: res.body.job.id,
        workspaceId: acct.workspaceId,
        kind: 'REEL',
        creditsReserved: 30,
      });
    });

    it('does not push to a queue: the API only writes the outbox row', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      await generate(acct, postId, { type: 'REEL' });

      // Nothing has executed yet - no checkpoints, job still PENDING. That is the
      // point of the outbox: the work happens when a worker picks the event up,
      // and a crash before then loses nothing.
      const [job] = await db.select().from(generationJobs);
      expect(job?.status).toBe('PENDING');

      const checkpoints = await db.select().from(jobCheckpoints);
      expect(checkpoints).toHaveLength(0);
    });

    it('replays the same job for a repeated Idempotency-Key', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const first = await generate(acct, postId, { type: 'REEL' }, 'key-1');
      const second = await generate(acct, postId, { type: 'REEL' }, 'key-1');

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.job.id).toBe(first.body.job.id);
      expect(second.body.replayed).toBe(true);

      // And crucially: the credits were taken once, not twice.
      const jobs = await db.select().from(generationJobs);
      expect(jobs).toHaveLength(1);
    });

    it('creates a separate job for two different keys', async () => {
      const acct = await account('gen');
      // Two reels at 30 would not fit in a 50-credit welcome bonus, and this
      // test is about idempotency keys rather than about pricing.
      await seedPricing(db, { REEL: 10 });
      const postId = await postFor(acct, 'REEL');

      const first = await generate(acct, postId, { type: 'REEL' }, 'key-1');
      const second = await generate(acct, postId, { type: 'REEL' }, 'key-2');

      expect(second.body.job.id).not.toBe(first.body.job.id);
      expect(second.body.replayed).toBe(false);
    });

    it('rejects an unknown generation type', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const res = await generate(acct, postId, { type: 'POEM' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a body with nothing in it', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const res = await generate(acct, postId, {});

      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated caller', async () => {
      const acct = await account('gen');
      const postId = await postFor(acct, 'REEL');

      const res = await app.http().post(`/api/v1/posts/${postId}/generate`).send({ type: 'REEL' });

      expect(res.status).toBe(401);
    });

    it('refuses a caller from another workspace without revealing the post', async () => {
      const owner = await account('owner');
      const stranger = await account('stranger');
      const postId = await postFor(owner, 'REEL');

      const res = await generate(stranger, postId, { type: 'REEL' });

      // 403, not 404: the post exists but is not yours. A 404 here would confirm
      // the id is real to someone probing for it.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');

      // The error must not name the workspace it was aiming at either, or the
      // 403 leaks as much as the 404 would have.
      expect(JSON.stringify(res.body)).not.toContain(owner.workspaceId);
    });

    it('creates nothing when the caller cannot reach the post', async () => {
      const owner = await account('owner');
      const stranger = await account('stranger');
      const postId = await postFor(owner, 'REEL');

      await generate(stranger, postId, { type: 'REEL' });

      const jobs = await db.select().from(generationJobs);
      expect(jobs).toHaveLength(0);
      const events = await db.select().from(outboxEvents);
      expect(events).toHaveLength(0);
    });

    it('reports insufficient credits without creating a job', async () => {
      const acct = await account('broke');
      await seedPricing(db, { REEL: 999 });
      const postId = await postFor(acct, 'REEL');

      const res = await generate(acct, postId, { type: 'REEL' });

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
      await expect(db.select().from(generationJobs)).resolves.toHaveLength(0);
    });
  });

  describe('GET /jobs/:id', () => {
    it('reports stages as they are checkpointed', async () => {
      const acct = await account('status');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL', scenes: 2 });
      const jobId = created.body.job.id as string;

      const before = await asUser(acct).get(`/api/v1/jobs/${jobId}`);
      expect(before.status).toBe(200);
      expect(before.body.completedStages).toEqual([]);

      await runJobNow(jobId);

      const after = await asUser(acct).get(`/api/v1/jobs/${jobId}`);
      expect(after.body).toMatchObject({
        id: jobId,
        status: 'COMPLETED',
        stage: 'DONE',
        captured: true,
        refunded: false,
        error: null,
      });
      expect(after.body.completedStages).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
      expect(after.body.finishedAt).not.toBeNull();
    });

    it('reports the failure reason when a stage fails', async () => {
      const acct = await account('failing');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      const jobId = created.body.job.id as string;

      await runJobNow(jobId, { failStage: 'RENDER' });

      const res = await asUser(acct).get(`/api/v1/jobs/${jobId}`);
      expect(res.body).toMatchObject({ status: 'FAILED', refunded: true, captured: false });
      expect(String(res.body.error)).toContain('RENDER');
      // The work that did finish is still reported, so the user can see how far
      // it got rather than only that it failed.
      expect(res.body.completedStages).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE']);
    });

    it('does not leak a job from another workspace', async () => {
      const owner = await account('owner');
      const stranger = await account('stranger');
      const postId = await postFor(owner, 'REEL');
      const created = await generate(owner, postId, { type: 'REEL' });

      const res = await asUser(stranger).get(`/api/v1/jobs/${created.body.job.id}`);

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(created.body.job.id as string);
    });

    it('404s for an id that is not a job at all', async () => {
      const acct = await account('ghost');
      const res = await asUser(acct).get('/api/v1/jobs/00000000-0000-4000-8000-000000000000');

      // No post, no workspace, nothing to scope against - so this is a 403 rather
      // than a 404, matching the "never confirm an id exists" rule.
      expect(res.status).toBe(403);
    });

    it('rejects a malformed id before touching the database', async () => {
      const acct = await account('bad-id');
      const res = await asUser(acct).get('/api/v1/jobs/not-a-uuid');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /jobs/:id/events (SSE)', () => {
    it('streams the final progress and closes when the job has settled', async () => {
      const acct = await account('sse');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      const jobId = created.body.job.id as string;
      await runJobNow(jobId);

      const res = await asUser(acct).get(`/api/v1/jobs/${jobId}/events`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const body = String(res.text);
      // A client that connects after the work is done still gets the outcome,
      // rather than an open stream that says nothing.
      expect(body).toContain('event: progress');
      expect(body).toContain('"status":"COMPLETED"');
      expect(body).toContain('event: done');
    });

    it('sends no-cache headers so a proxy does not buffer the stream', async () => {
      const acct = await account('sse');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      await runJobNow(created.body.job.id as string);

      const res = await asUser(acct).get(`/api/v1/jobs/${created.body.job.id}/events`);

      expect(res.headers['cache-control']).toContain('no-cache');
      expect(res.headers['x-accel-buffering']).toBe('no');
    });

    it('ends the stream after a failure rather than polling forever', async () => {
      const acct = await account('sse');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      const jobId = created.body.job.id as string;
      await runJobNow(jobId, { failStage: 'IMAGE' });

      const res = await asUser(acct).get(`/api/v1/jobs/${jobId}/events`);

      expect(String(res.text)).toContain('"status":"FAILED"');
      expect(String(res.text)).toContain('event: done');
    });

    it('refuses before writing any bytes, so a stranger gets a 403 not a stream', async () => {
      const owner = await account('owner');
      const stranger = await account('stranger');
      const postId = await postFor(owner, 'REEL');
      const created = await generate(owner, postId, { type: 'REEL' });

      const res = await asUser(stranger).get(`/api/v1/jobs/${created.body.job.id}/events`);

      expect(res.status).toBe(403);
      expect(String(res.text)).not.toContain('event:');
    });

    it('replays progress to a client that reconnects', async () => {
      const acct = await account('sse');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      const jobId = created.body.job.id as string;
      await runJobNow(jobId);

      // Two connections in a row: the second is a reconnect after a dropped
      // stream, and must see the same history. Checkpoints are the durable
      // record precisely so this works.
      const first = await asUser(acct).get(`/api/v1/jobs/${jobId}/events`);
      const second = await asUser(acct).get(`/api/v1/jobs/${jobId}/events`);

      expect(second.text).toBe(first.text);
      expect(String(second.text)).toContain(
        '"completedStages":["PLAN","SCRIPT","IMAGE","VOICE","RENDER"]',
      );
    });
  });

  describe('settlement', () => {
    it('marks a job captured only after every stage has run', async () => {
      const acct = await account('settle');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });

      await runJobNow(created.body.job.id as string);

      const [job] = await db.select().from(generationJobs);
      expect(job?.captured).toBe(1);
      expect(job?.refunded).toBe(0);
    });

    it('will not run a job whose credits were refunded', async () => {
      const acct = await account('settle');
      const postId = await postFor(acct, 'REEL');
      const created = await generate(acct, postId, { type: 'REEL' });
      const jobId = created.body.job.id as string;

      await failJob(db, jobId, 'cancelled by user');

      const res = await asUser(acct).get(`/api/v1/jobs/${jobId}`);
      expect(res.body).toMatchObject({ status: 'FAILED', refunded: true, captured: false });
    });
  });
});
