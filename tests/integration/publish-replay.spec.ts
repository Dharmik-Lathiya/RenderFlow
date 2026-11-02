import { eq, sql } from 'drizzle-orm';

import {
  auditLogs,
  brands,
  campaigns,
  outboxEvents,
  posts,
  publishJobs,
  socialAccounts,
} from '@renderflow/db';

import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Publish replay (ARCH-08).
 *
 * The endpoint deliberately does not touch credits - the post's generation was
 * charged once, when it was created - so these tests are about the other
 * invariant: a job that already produced an external post must never be
 * replayed. Asserting the row and the outbox together is what proves the
 * decision and the event are one transaction rather than two hopeful writes.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

interface Fixture {
  jobId: string;
  postId: string;
  workspaceId: string;
}

describe('admin: publish replay (ARCH-08)', () => {
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
    post: (url: string) => app.http().post(url).set('Authorization', `Bearer ${acct.accessToken}`),
  });

  function only<T>(row: T | undefined, what: string): T {
    if (row === undefined) {
      throw new Error(`expected exactly one ${what}`);
    }
    return row;
  }

  /**
   * A FAILED publish job with no external post id.
   *
   * `connectedBy` is the account owner the notification path resolves, not the
   * post author; the replay path itself only needs the workspace join.
   */
  async function failedPublishJob(
    acct: Account,
    overrides: { status?: 'FAILED' | 'PENDING'; externalPostId?: string | null } = {},
  ): Promise<Fixture> {
    const [brand] = await db
      .insert(brands)
      .values({
        workspaceId: acct.workspaceId,
        name: 'Acme',
        industry: 'retail',
        colors: [],
        languages: ['en'],
      })
      .returning({ id: brands.id });

    const [campaign] = await db
      .insert(campaigns)
      .values({
        brandId: only(brand, 'brand').id,
        goal: 'launch',
        status: 'ACTIVE',
        createdBy: acct.userId,
      })
      .returning({ id: campaigns.id });

    const [post] = await db
      .insert(posts)
      .values({
        campaignId: only(campaign, 'campaign').id,
        brandId: only(brand, 'brand').id,
        type: 'CAPTION',
        caption: 'Replay me',
        hashtags: '',
        status: 'FAILED',
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: posts.id });

    const [social] = await db
      .insert(socialAccounts)
      .values({
        workspaceId: acct.workspaceId,
        platform: 'linkedin',
        externalAccountId: `urn:li:person:${acct.userId.slice(0, 8)}`,
        displayName: 'Acme LinkedIn',
        token: 'ciphertext-not-used-by-this-test',
        connectedBy: acct.userId,
      })
      .returning({ id: socialAccounts.id });

    const [job] = await db
      .insert(publishJobs)
      .values({
        postId: only(post, 'post').id,
        socialAccountId: only(social, 'social account').id,
        status: overrides.status ?? 'FAILED',
        scheduledFor: new Date(Date.now() - 60_000),
        platformContent: 'Replay me',
        attempts: 3,
        error: 'access token expired',
        externalPostId: overrides.externalPostId ?? null,
      })
      .returning({ id: publishJobs.id });

    return {
      jobId: only(job, 'publish job').id,
      postId: only(post, 'post').id,
      workspaceId: acct.workspaceId,
    };
  }

  async function rowFor(jobId: string) {
    return (await db.select().from(publishJobs).where(eq(publishJobs.id, jobId)).limit(1))[0];
  }

  it('resets the job, writes an audit row and emits the retry event', async () => {
    const acct = await account('replay-owner');
    const fixture = await failedPublishJob(acct);

    const res = await asUser(acct)
      .post(`/api/v1/admin/publish/${fixture.jobId}/replay`)
      .send({ reason: 'provider recovered' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      jobId: fixture.jobId,
      postId: fixture.postId,
      platform: 'linkedin',
      requeued: true,
    });

    const job = await rowFor(fixture.jobId);
    expect(job).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      error: null,
      externalPostId: null,
      workerId: null,
      lockedUntil: null,
    });
    // An explicit replay runs now, not whenever the original schedule was.
    expect(job?.scheduledFor.getTime()).toBeGreaterThan(Date.now() - 5_000);

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, fixture.jobId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: acct.userId,
      action: 'publish.replay',
      entity: 'publish_job',
    });
    expect(audit[0]?.meta).toMatchObject({ reason: 'provider recovered' });

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, fixture.jobId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'PUBLISH_JOB',
      eventType: 'publish.retry',
      processedAt: null,
      attempts: 0,
    });
    expect(events[0]?.payload).toMatchObject({
      eventType: 'publish.retry',
      publishJobId: fixture.jobId,
      postId: fixture.postId,
      platform: 'linkedin',
    });
  });

  it('refuses a replay of a post that already exists on the platform', async () => {
    // This is the invariant the endpoint exists to protect: a second publish
    // would put the same post in front of the audience twice.
    const acct = await account('replay-published');
    const fixture = await failedPublishJob(acct, { externalPostId: 'urn:li:share:123' });

    const res = await asUser(acct).post(`/api/v1/admin/publish/${fixture.jobId}/replay`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');

    const job = await rowFor(fixture.jobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.externalPostId).toBe('urn:li:share:123');

    expect(
      await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, fixture.jobId)),
    ).toHaveLength(0);
  });

  it('is idempotent under a double replay', async () => {
    const acct = await account('replay-twice');
    const fixture = await failedPublishJob(acct);
    const url = `/api/v1/admin/publish/${fixture.jobId}/replay`;

    const first = await asUser(acct).post(url).send({});
    const second = await asUser(acct).post(url).send({});

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);

    // One state transition, one event, one audit row.
    expect(
      await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, fixture.jobId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.entityId, fixture.jobId)),
    ).toHaveLength(1);
  });

  it('does not let one workspace replay another workspace job', async () => {
    const owner = await account('replay-target');
    const stranger = await account('replay-stranger');
    const fixture = await failedPublishJob(owner);

    const res = await asUser(stranger)
      .post(`/api/v1/admin/publish/${fixture.jobId}/replay`)
      .send({});

    // 404, not 403: a scoped operator must not learn that the id exists.
    expect(res.status).toBe(404);
    expect((await rowFor(fixture.jobId))?.status).toBe('FAILED');
  });

  it('refuses a non-operator', async () => {
    const acct = await account('replay-member');
    const fixture = await failedPublishJob(acct);

    await db.execute(sql`DELETE FROM workspace_members WHERE user_id = ${acct.userId}::uuid`);

    const res = await asUser(acct).post(`/api/v1/admin/publish/${fixture.jobId}/replay`).send({});

    expect(res.status).toBe(403);
    expect((await rowFor(fixture.jobId))?.status).toBe('FAILED');
  });
});
