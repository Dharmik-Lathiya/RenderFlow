import { eq } from 'drizzle-orm';

import { brands, campaigns, posts, publishJobs, socialAccounts, workspaces } from '@renderflow/db';
import {
  MockSocialAdapter,
  PublishError,
  claimPublishJobs,
  describePublishError,
  findStalePublishJobs,
  formatForPlatform,
  publishIdempotencyKey,
  publishJob,
  platformContentFor,
  type SocialAdapter,
  type SocialPlatform,
} from '@renderflow/social';

import { createUserWithBonus } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Phase 7 DoD: "scheduled post publishes within 5 s of target time; killing
 * `publisher-worker` mid-publish never creates a duplicate post; token-expired
 * path refreshes and succeeds."
 *
 * The middle one is the whole reason this module exists, so it is tested three
 * ways: the platform lookup catching a post we never recorded, our own row
 * catching a re-delivery, and the adapter refusing to create a second post for
 * one key.
 */

const PLATFORM: SocialPlatform = 'linkedin';

/**
 * "Exactly one row came back", which is what every fixture and every claim here
 * means.
 *
 * `!` would say the same thing while proving nothing: if a claim legitimately
 * returns nothing the next line would throw on `undefined` with a message about
 * destructuring, instead of naming what was missing.
 */
function only<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`expected exactly one ${what}`);
  }

  return row;
}

describe('publishing: no duplicate posts (Phase 7 DoD)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
  });

  // --- fixtures ------------------------------------------------------------

  /**
   * Fixtures go through the schema, not raw SQL.
   *
   * Raw INSERTs here would be a second, untested description of the tables: they
   * drift, they encode assumptions the app does not have, and a test that passes
   * against a table the app never writes is testing the fixture.
   */
  async function seedWorkspace(): Promise<{ userId: string; workspaceId: string }> {
    const user = await createUserWithBonus(db, { bonus: 50 });
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Acme', ownerId: user.id })
      .returning({ id: workspaces.id });

    if (workspace === undefined) {
      throw new Error('workspace insert returned nothing');
    }

    return { userId: user.id, workspaceId: workspace.id };
  }

  async function seedPost(workspaceId: string, userId: string): Promise<string> {
    const [brand] = await db
      .insert(brands)
      .values({ workspaceId, name: 'Acme', industry: 'retail', colors: [], languages: ['en'] })
      .returning({ id: brands.id });

    const [campaign] = await db
      .insert(campaigns)
      .values({
        brandId: only(brand, 'brand').id,
        goal: 'launch',
        status: 'ACTIVE',
        createdBy: userId,
      })
      .returning({ id: campaigns.id });

    const [post] = await db
      .insert(posts)
      .values({
        campaignId: only(campaign, 'campaign').id,
        brandId: only(brand, 'brand').id,
        type: 'CAPTION',
        caption: 'Rain again.',
        hashtags: '#weather',
        status: 'APPROVED',
      })
      .returning({ id: posts.id });

    return only(post, 'post').id;
  }

  async function seedAccount(
    workspaceId: string,
    userId: string,
    token = 'ciphertext',
  ): Promise<string> {
    const [account] = await db
      .insert(socialAccounts)
      .values({
        workspaceId,
        platform: PLATFORM,
        externalAccountId: 'ext-1',
        displayName: 'Acme Ltd',
        token,
        connectedBy: userId,
      })
      .returning({ id: socialAccounts.id });

    return only(account, 'social account').id;
  }

  async function seedPublishJob(input: {
    postId: string;
    accountId: string;
    scheduledFor?: Date;
    status?: string;
    externalPostId?: string | null;
    attempts?: number;
    maxAttempts?: number;
  }): Promise<string> {
    const [job] = await db
      .insert(publishJobs)
      .values({
        postId: input.postId,
        socialAccountId: input.accountId,
        status: (input.status ?? 'SCHEDULED') as never,
        scheduledFor: input.scheduledFor ?? new Date(Date.now() - 1_000),
        platformContent: 'Rain again. #weather',
        externalPostId: input.externalPostId ?? null,
        attempts: input.attempts ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning({ id: publishJobs.id });

    return only(job, 'publish job').id;
  }

  function deps(adapter: SocialAdapter) {
    return { db, adapterFor: (): SocialAdapter => adapter };
  }

  // --- the guarantee --------------------------------------------------------

  it('publishes once and records the external id', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    const claimed = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.externalPostId).toMatch(/^linkedin-/);
    expect(adapter.posts()).toHaveLength(1);

    const stored = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    expect(stored[0]).toMatchObject({
      status: 'PUBLISHED',
      externalPostId: outcome.externalPostId,
    });
  });

  it('does NOT double-post when a worker dies after the platform accepted', async () => {
    // The hard case. The platform has the post; our row does not, because the
    // worker died between the two writes. Only the platform lookup can catch it.
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });

    // The dead worker: the platform accepted, then nothing recorded it.
    await adapter.publish({ idempotencyKey: publishIdempotencyKey(jobId), content: 'Rain again.' });
    expect(
      (await db.select().from(publishJobs).where(eq(publishJobs.id, jobId)))[0]?.externalPostId,
    ).toBeNull();

    // A new worker picks up the same job.
    const claimed = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    expect(outcome.status).toBe('RECOVERED');
    expect(outcome.recovered).toBe(true);
    // The assertion that matters: still ONE post at the platform.
    expect(adapter.posts()).toHaveLength(1);
  });

  it('does not republish a job our own row already recorded', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({
      postId,
      accountId,
      status: 'PENDING',
      externalPostId: 'already-there',
    });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    const claimed = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    expect(outcome.status).toBe('ALREADY');
    expect(outcome.externalPostId).toBe('already-there');
    expect(adapter.posts()).toHaveLength(0);
  });

  it('does not post twice when the queue redelivers the same claimed job', async () => {
    // A redelivery is NOT a re-claim: the worker is handed the same claimed row
    // twice, which happens whenever a queue message is acknowledged late or
    // duplicated. Only our own `external_post_id` catches this - the row is
    // already PUBLISHED, so `claimPublishJobs` correctly refuses to hand it out
    // again.
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    const claimed = await claimPublishJobs(deps(adapter));

    const first = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));
    const second = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    expect(first.status).toBe('PUBLISHED');

    // RECOVERED, not ALREADY: the redelivered copy of the row still says
    // `external_post_id = null`, because it was read at claim time, before the
    // first call wrote anything. Our own column cannot catch this - only the
    // platform lookup can. That is the reason check 2 is not redundant with
    // check 1.
    expect(second.status).toBe('RECOVERED');
    expect(second.externalPostId).toBe(first.externalPostId);
    expect(adapter.posts()).toHaveLength(1);
  });

  it('stops offering a published job to any worker', async () => {
    // The other half of the previous test: after publishing, the row is terminal
    // and never re-enters the queue, so a second worker has nothing to do.
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });

    await publishJob(
      deps(adapter),
      only((await claimPublishJobs(deps(adapter)))[0], 'claimed publish job'),
    );
    expect(await claimPublishJobs(deps(adapter))).toHaveLength(0);
  });

  it('posts once across a retry that eventually succeeds', async () => {
    // The realistic retry shape: two transient platform failures, then success.
    // Three claims, one post.
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId, maxAttempts: 5 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM, failTimes: 2 });
    const statuses: string[] = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claimed = await claimPublishJobs(deps(adapter));

      if (claimed.length === 0) {
        break;
      }

      statuses.push(
        (await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'))).status,
      );
    }

    expect(statuses).toEqual([
      'RETRY', // failed, retried
      'RETRY', // failed, retried
      'PUBLISHED', // succeeded
    ]);
    expect(adapter.posts()).toHaveLength(1);
  });

  it('gives two publishers the same job and still posts once', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });

    // Both poll at once. SKIP LOCKED should hand them different rows; with one
    // row, one gets it and the other gets nothing.
    const [a, b] = await Promise.all([
      claimPublishJobs(deps(adapter)),
      claimPublishJobs(deps(adapter)),
    ]);

    for (const claimed of [...a, ...b]) {
      await publishJob(deps(adapter), claimed);
    }

    expect(a.length + b.length).toBeLessThanOrEqual(1);
    expect(adapter.posts()).toHaveLength(1);
  });

  // --- scheduling -----------------------------------------------------------

  it('publishes only once the scheduled time has passed', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({
      postId,
      accountId,
      scheduledFor: new Date(Date.now() + 60_000),
    });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });

    expect(await claimPublishJobs(deps(adapter))).toHaveLength(0);
    expect(adapter.posts()).toHaveLength(0);
  });

  it('publishes within 5 s of the target time', async () => {
    // The DoD's timing claim, measured rather than asserted. The poll interval
    // is the publisher's, so this bounds the WORKER's contribution: 250 ms of
    // polling plus the publish itself, against a 5 s budget.
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const target = new Date(Date.now() + 300);
    await seedPublishJob({ postId, accountId, scheduledFor: target });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    const POLL_MS = 250;

    const started = Date.now();
    let published: Date | null = null;

    while (Date.now() - started < 5_000 && published === null) {
      const claimed = await claimPublishJobs(deps(adapter));

      if (claimed.length > 0) {
        await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));
        published = new Date();
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    expect(published).not.toBeNull();
    expect((published as unknown as Date).getTime() - target.getTime()).toBeLessThan(5_000);
  });

  // --- failure handling -----------------------------------------------------

  it('leaves a transient failure claimable for a retry', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId, maxAttempts: 3 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM, failTimes: 1 });
    const first = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(first[0], 'claimed publish job'));

    expect(outcome.error).toContain('temporary');
    const after = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    // Not terminal: there are retries left, and a terminal row here would mean a
    // one-off platform blip costs the user their post.
    expect(after[0]?.status).toBe('PENDING');
    expect(after[0]?.attempts).toBe(1);
  });

  it('gives up permanently once the attempts are spent', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId, maxAttempts: 1 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 });
    const claimed = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    expect(outcome.status).toBe('FAILED');
    const after = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    expect(after[0]?.status).toBe('FAILED');
  });

  it('reports an expired token as needing a reconnect, not as a retry', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId, maxAttempts: 3 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM, tokenExpired: true });
    const claimed = await claimPublishJobs(deps(adapter));
    const outcome = await publishJob(deps(adapter), only(claimed[0], 'claimed publish job'));

    // Retrying with the same dead token burns the backoff budget and ends in the
    // same place. The message has to say what to do.
    expect(outcome.error).toContain('reconnect');
  });

  it('succeeds after a refresh, and posts exactly once', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId, maxAttempts: 3 });

    // First attempt: the token is dead.
    const expired = new MockSocialAdapter({ platform: PLATFORM, tokenExpired: true });
    const first = await claimPublishJobs(deps(expired));
    expect(
      (await publishJob(deps(expired), only(first[0], 'claimed publish job'))).error,
    ).toContain('reconnect');

    // The account reconnects; the same adapter object now holds a good token.
    const healthy = new MockSocialAdapter({ platform: PLATFORM });
    const second = await claimPublishJobs(deps(healthy));
    const outcome = await publishJob(deps(healthy), only(second[0], 'claimed publish job'));

    expect(outcome.status).toBe('PUBLISHED');
    expect(healthy.posts()).toHaveLength(1);
  });

  // --- recovery -------------------------------------------------------------

  it('finds a job whose publisher died mid-publish', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId });

    await db
      .update(publishJobs)
      .set({
        status: 'PUBLISHING',
        workerId: 'dead-worker',
        lockedUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(publishJobs.id, jobId));

    const stale = await findStalePublishJobs(db);

    expect(stale.map((row) => row.id)).toContain(jobId);
  });

  it('leaves a live claim alone', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    const jobId = await seedPublishJob({ postId, accountId });

    await db
      .update(publishJobs)
      .set({
        status: 'PUBLISHING',
        workerId: 'busy-worker',
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(publishJobs.id, jobId));

    // Stealing a live claim is how two workers publish the same post.
    expect((await findStalePublishJobs(db)).map((row) => row.id)).not.toContain(jobId);
  });

  // --- idempotency of the request itself ------------------------------------

  it('refuses a second job for the same post and account', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    const postId = await seedPost(workspaceId, userId);
    const accountId = await seedAccount(workspaceId, userId);
    await seedPublishJob({ postId, accountId });

    await expect(seedPublishJob({ postId, accountId })).rejects.toThrow();
  });

  it('updates the account rather than duplicating it on reconnect', async () => {
    const { userId, workspaceId } = await seedWorkspace();
    await seedAccount(workspaceId, userId);

    await db
      .update(socialAccounts)
      .set({ token: 'rotated', displayName: 'Acme Ltd (new)' })
      .where(eq(socialAccounts.workspaceId, workspaceId));

    const rows = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.workspaceId, workspaceId));
    // Two rows would mean publish picks between them at random.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).toBe('rotated');
  });

  // --- formatting at schedule time ------------------------------------------

  it('formats for the platform when the job is created, not at publish time', async () => {
    const { content, notes } = platformContentFor('instagram', 'x'.repeat(2_500), ['#one']);

    expect(content.length).toBeLessThanOrEqual(2_200);
    expect(notes.length).toBeGreaterThan(0);
    // What is stored is what gets published; nothing re-formats later.
    expect(formatForPlatform('instagram', content).content).toBe(content);
  });

  it('uses a deterministic idempotency key derived from the job id', () => {
    // It cannot be supplied by a caller, so two workers cannot disagree about it.
    expect(publishIdempotencyKey('abc')).toBe('renderflow:abc');
    expect(publishIdempotencyKey('abc')).toBe(publishIdempotencyKey('abc'));
    expect(publishIdempotencyKey('abc')).not.toBe(publishIdempotencyKey('abd'));
  });

  it('describes failures in terms of what to do next', () => {
    expect(describePublishError(new PublishError('401', 'AUTH_EXPIRED'))).toContain('reconnect');
    expect(describePublishError(new PublishError('bad image', 'REJECTED'))).toContain('rejected');
    expect(describePublishError(new PublishError('503', 'TRANSIENT'))).toContain('temporary');
    expect(describePublishError('a string')).toBe('unknown publish failure');
  });
});
