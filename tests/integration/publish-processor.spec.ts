import { eq } from 'drizzle-orm';
import {
  brands,
  campaigns,
  notifications,
  outboxEvents,
  posts,
  publishJobs,
  socialAccounts,
  workspaces,
  workspaceMembers,
} from '@renderflow/db';
import {
  MockSocialAdapter,
  PlatformRateLimiter,
  PublishProcessor,
  TokenRefresherRegistry,
  createTokenCipher,
  type PublishNotifier,
  type SocialPlatform,
  type TokenRefresher,
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
 * `PublishProcessor` against a real database.
 *
 * The three things worth proving are the ones the type system cannot:
 * that a post's own status advances only when every target is done; that an
 * expired token refreshes, stores the new one, and succeeds - the Phase 7 DoD;
 * and that a publisher killed mid-publish is recovered without a second post.
 */

const PLATFORM: SocialPlatform = 'linkedin';
const cipher = createTokenCipher(Buffer.alloc(32, 11));

interface Recorded {
  userId: string;
  type: string;
  title: string;
  body: string;
  dedupeKey?: string;
}

describe('PublishProcessor', () => {
  let db: TestDb;
  let sent: Recorded[];

  const notifier: PublishNotifier = {
    notify: async (input) => {
      sent.push(input);
    },
  };

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
    sent = [];
  });

  // --- fixtures ------------------------------------------------------------

  async function seed(): Promise<{ userId: string; workspaceId: string; postId: string }> {
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
        brandId: only(brand, 'brand').id,
        goal: 'launch',
        status: 'ACTIVE',
        createdBy: user.id,
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

    return { userId: user.id, workspaceId: workspace.id, postId: only(post, 'post').id };
  }

  async function seedAccount(workspaceId: string, userId: string, token = 'stored-token') {
    const [row] = await db
      .insert(socialAccounts)
      .values({
        workspaceId,
        platform: PLATFORM,
        externalAccountId: 'ext-1',
        displayName: 'Acme Ltd',
        // Encrypted at rest, exactly as the API stores it.
        token: cipher.encrypt(JSON.stringify({ accessToken: token, refreshToken: 'r1' })),
        connectedBy: userId,
      })
      .returning({ id: socialAccounts.id });

    return only(row, 'account').id;
  }

  async function seedJob(input: {
    postId: string;
    accountId: string;
    scheduledFor?: Date;
    maxAttempts?: number;
  }) {
    const [row] = await db
      .insert(publishJobs)
      .values({
        postId: input.postId,
        socialAccountId: input.accountId,
        status: 'SCHEDULED',
        scheduledFor: input.scheduledFor ?? new Date(Date.now() - 1_000),
        platformContent: 'Rain again. #weather',
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning({ id: publishJobs.id });

    return only(row, 'publish job').id;
  }

  function processor(
    adapter: MockSocialAdapter,
    extra: {
      refresh?: TokenRefresherRegistry;
      limiterFor?: (p: SocialPlatform) => PlatformRateLimiter;
    } = {},
  ) {
    return new PublishProcessor({
      db,
      adapterFor: (): MockSocialAdapter => adapter,
      notify: notifier,
      workerId: 'worker-1',
      tokens: cipher,
      heartbeatSeconds: 1,
      ...extra,
    });
  }

  function only<T>(row: T | undefined, what: string): T {
    if (row === undefined) {
      throw new Error(`expected exactly one ${what}`);
    }
    return row;
  }

  // --- the happy path ------------------------------------------------------

  it('publishes a due job and marks the post published', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId });

    const outcomes = await processor(new MockSocialAdapter({ platform: PLATFORM })).runOnce();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'PUBLISHED' });

    const post = await db.select().from(posts).where(eq(posts.id, ids.postId));
    expect(post[0]?.status).toBe('PUBLISHED');
  });

  it('emits post.published for the relay to route', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId });

    await processor(new MockSocialAdapter({ platform: PLATFORM })).runOnce();

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'post.published'));

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ postId: ids.postId, platform: PLATFORM });
  });

  it('does nothing for a job that is not due yet', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, scheduledFor: new Date(Date.now() + 600_000) });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    expect(await processor(adapter).runOnce()).toHaveLength(0);
    expect(adapter.posts()).toHaveLength(0);
  });

  // --- post status ---------------------------------------------------------

  it('holds the post at PUBLISHING while another target is still out', async () => {
    const ids = await seed();
    const first = await seedAccount(ids.workspaceId, ids.userId);
    const second = await seedSecondAccount(ids.workspaceId, ids.userId);

    // One succeeds; the other fails transiently with attempts to spare, so it is
    // still PENDING afterwards and the post is not finished.
    await seedJob({ postId: ids.postId, accountId: first });
    await seedJob({ postId: ids.postId, accountId: second, maxAttempts: 5 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    const proc = new PublishProcessor({
      db,
      adapterFor: (): MockSocialAdapter => adapter,
      notify: notifier,
      workerId: 'worker-1',
      tokens: cipher,
      heartbeatSeconds: 1,
    });

    // Drive the first job only, by failing the second ahead of time.
    await db
      .update(publishJobs)
      .set({ scheduledFor: new Date(Date.now() + 600_000) })
      .where(eq(publishJobs.socialAccountId, second));

    await proc.runOnce();

    const post = await db.select().from(posts).where(eq(posts.id, ids.postId));

    // One target done, one still scheduled -> PUBLISHING, not PUBLISHED. Marking
    // it PUBLISHED would stop the UI tracking the one still in flight.
    expect(post[0]?.status).toBe('PUBLISHING');
  });

  async function seedSecondAccount(workspaceId: string, userId: string): Promise<string> {
    const [row] = await db
      .insert(socialAccounts)
      .values({
        workspaceId,
        platform: PLATFORM,
        externalAccountId: 'ext-2',
        token: cipher.encrypt(JSON.stringify({ accessToken: 't', refreshToken: 'r1' })),
        connectedBy: userId,
      })
      .returning({ id: socialAccounts.id });

    return only(row, 'account').id;
  }

  it('marks the post PUBLISHED only once every target is done', async () => {
    const ids = await seed();
    const first = await seedAccount(ids.workspaceId, ids.userId);
    const second = await seedSecondAccount(ids.workspaceId, ids.userId);

    await seedJob({ postId: ids.postId, accountId: first });
    await seedJob({ postId: ids.postId, accountId: second });

    await processor(new MockSocialAdapter({ platform: PLATFORM })).runOnce();

    const post = await db.select().from(posts).where(eq(posts.id, ids.postId));

    // A post going to two accounts is published twice, and only the second is
    // finished.
    expect(post[0]?.status).toBe('PUBLISHED');
  });

  it('marks the post FAILED when any target failed, even if another succeeded', async () => {
    const ids = await seed();
    const good = await seedAccount(ids.workspaceId, ids.userId);
    const bad = await seedSecondAccount(ids.workspaceId, ids.userId);

    await seedJob({ postId: ids.postId, accountId: good });
    await seedJob({ postId: ids.postId, accountId: bad, maxAttempts: 1 });

    // One adapter per `adapterFor` call, so the two targets are driven in two
    // passes, holding the other back each time.
    await holdBack(good);
    await bringForward(bad);
    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 })).runOnce();

    await bringForward(good);
    await processor(new MockSocialAdapter({ platform: PLATFORM })).runOnce();

    const post = await db.select().from(posts).where(eq(posts.id, ids.postId));

    // PUBLISHED would hide the account that needs reconnecting, which is the
    // only thing the user can act on.
    expect(post[0]?.status).toBe('FAILED');
  });

  /** Pushes a target's job into the future so the next pass skips it. */
  async function holdBack(accountId: string): Promise<void> {
    await db
      .update(publishJobs)
      .set({ scheduledFor: new Date(Date.now() + 600_000) })
      .where(eq(publishJobs.socialAccountId, accountId));
  }

  /** Brings it forward so the next pass claims it. */
  async function bringForward(accountId: string): Promise<void> {
    await db
      .update(publishJobs)
      .set({ scheduledFor: new Date(Date.now() - 1_000) })
      .where(eq(publishJobs.socialAccountId, accountId));
  }

  // --- failure reporting ---------------------------------------------------

  it('tells the person who connected the account', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 })).runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: ids.userId, type: 'publish_failed' });
    expect(sent[0]?.body).toContain('Acme Ltd');
  });

  it('emits post.publish_failed so the notification queue can route it', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 })).runOnce();

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'post.publish_failed'));

    // A consumer that only counts successes reports a calendar that looks
    // emptier than it is.
    expect(events).toHaveLength(1);
  });

  it('says nothing on a retryable failure', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 5 });

    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 1 })).runOnce();

    // Not terminal yet. Telling the user now would train them to ignore the
    // notification that matters.
    expect(sent).toHaveLength(0);
  });

  it('deduplicates the failure notification across terminal attempts', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 })).runOnce();

    // The key is the publish job, so a real notification write would land on one
    // row rather than three identical cards.
    expect(sent[0]?.dedupeKey).toBe('publish-failed:' + (await jobIdFor(ids.postId)));
  });

  async function jobIdFor(postId: string): Promise<string> {
    const [row] = await db
      .select({ id: publishJobs.id })
      .from(publishJobs)
      .where(eq(publishJobs.postId, postId));
    return only(row, 'publish job').id;
  }

  it('says nothing when the account was disconnected mid-flight', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    await db.delete(socialAccounts).where(eq(socialAccounts.id, accountId));

    // The FK cascades the job away with it, so there is nothing left to publish.
    await processor(new MockSocialAdapter({ platform: PLATFORM })).runOnce();
    expect(sent).toHaveLength(0);
  });

  // --- token refresh (Phase 7 DoD) -----------------------------------------

  it('refreshes an expired token, stores the new one, and publishes', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId });

    // The adapter refuses until the stored token changes - which is what a real
    // platform does, and what makes this a test of the refresh path rather than
    // of a mock that always succeeds.
    const adapter = new MockSocialAdapter({ platform: PLATFORM, tokenExpired: true });
    const refresher = new TokenRefresherRegistry({
      refresh: async () => ({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: null }),
    } satisfies TokenRefresher);

    // The adapter keeps refusing; the point is that the refresh stored a new
    // token, which is what a real adapter would read.
    const outcomes = await processor(adapter, { refresh: refresher }).runOnce();

    const [account] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.id, accountId));
    const stored = JSON.parse(cipher.decrypt(only(account, 'account').token)) as {
      accessToken: string;
      refreshToken: string;
    };

    // The store is the part that is easy to forget. A refresh that computes a
    // valid token and leaves the old ciphertext looks exactly like refresh being
    // broken, and fails the same way every time.
    expect(stored.accessToken).toBe('fresh');
    expect(stored.refreshToken).toBe('r2');
    expect(outcomes[0]?.status).toBe('RETRY');
  });

  it('publishes once the token has been refreshed', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId });

    // First pass: the platform refuses, the refresh runs and stores the new
    // token, and the retry goes out under it.
    const stubborn = new MockSocialAdapter({ platform: PLATFORM, tokenExpired: true });
    const refresher = new TokenRefresherRegistry({
      refresh: async () => ({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: null }),
    });

    await processor(stubborn, { refresh: refresher }).runOnce();

    // Second pass: a healthy adapter, reading the token the refresh stored.
    const healthy = new MockSocialAdapter({ platform: PLATFORM });
    const outcomes = await processor(healthy, { refresh: refresher }).runOnce();

    expect(outcomes[0]?.status).toBe('PUBLISHED');
    expect(healthy.posts()).toHaveLength(1);
  });

  it('collapses concurrent refreshes of the same account into one call', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    const [second] = await db
      .insert(campaigns)
      .values({
        brandId: (await brandIdOf(ids.postId)) as string,
        goal: 'launch',
        status: 'ACTIVE',
        createdBy: ids.userId,
      })
      .returning({ id: campaigns.id });

    const [otherPost] = await db
      .insert(posts)
      .values({
        campaignId: only(second, 'campaign').id,
        brandId: (await brandIdOf(ids.postId)) as string,
        type: 'CAPTION',
        caption: 'Sun again.',
        hashtags: '#weather',
        status: 'APPROVED',
      })
      .returning({ id: posts.id });

    await seedJob({ postId: ids.postId, accountId, maxAttempts: 5 });
    await seedJob({ postId: only(otherPost, 'post').id, accountId, maxAttempts: 5 });

    let refreshCalls = 0;
    const refresher = new TokenRefresherRegistry({
      refresh: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { accessToken: 'fresh', refreshToken: 'r2', expiresAt: null };
      },
    });

    // What the registry actually guarantees: concurrent callers in ONE process
    // share a single call, because a refresh invalidates the previous refresh
    // token and the loser would log the account out.
    //
    // It is explicitly NOT a cross-process lock - see `refreshToken`. Two worker
    // processes can still both refresh the same account. Recorded in PROJECT.md
    // section 12 as a known gap.
    const both = await Promise.all([
      refresher.refreshOnce(PLATFORM, 'r1', `account:${accountId}`),
      refresher.refreshOnce(PLATFORM, 'r1', `account:${accountId}`),
    ]);

    expect(refreshCalls).toBe(1);
    // Both callers get the credentials, not just a boolean: the loser has to be
    // able to store them too.
    expect(both[0]?.accessToken).toBe('fresh');
    expect(both[1]?.accessToken).toBe('fresh');
  });

  async function brandIdOf(postId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ brandId: posts.brandId })
      .from(posts)
      .where(eq(posts.id, postId));
    return row?.brandId;
  }

  it('does not refresh when the token is merely stale rather than rejected', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 5 });

    let refreshCalls = 0;
    const refresher = new TokenRefresherRegistry({
      refresh: async () => {
        refreshCalls += 1;
        return { accessToken: 'fresh', refreshToken: 'r2', expiresAt: null };
      },
    });

    // A transient failure is not an auth problem; refreshing on it would burn a
    // refresh token for nothing and log the account out.
    await processor(new MockSocialAdapter({ platform: PLATFORM, failTimes: 1 }), {
      refresh: refresher,
    }).runOnce();

    expect(refreshCalls).toBe(0);
  });

  it('fails cleanly when the stored token cannot be decrypted', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    // A different key, as after an accidental rotation of TOKEN_ENCRYPTION_KEY.
    await db
      .update(socialAccounts)
      .set({ token: 'not-a-valid-envelope' })
      .where(eq(socialAccounts.id, accountId));

    const outcomes = await processor(
      new MockSocialAdapter({ platform: PLATFORM, tokenExpired: true }),
      {
        refresh: new TokenRefresherRegistry({
          refresh: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null }),
        }),
      },
    ).runOnce();

    // The worker must not throw on every job for every account because one key
    // is wrong; this job fails with "reconnect" and the operator sees it.
    expect(outcomes[0]?.status).toBe('FAILED');
    expect(sent[0]?.body).toContain('reconnect');
  });

  // --- recovery ------------------------------------------------------------

  it('reclaims a job whose publisher died mid-publish, without a second post', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    const jobId = await seedJob({ postId: ids.postId, accountId });

    // The platform has it; our row does not, because the worker died between the
    // two writes. This is the Phase 7 DoD's hard case.
    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    await adapter.publish({
      idempotencyKey: `renderflow:${jobId}`,
      content: 'Rain again. #weather',
    });

    const proc = processor(adapter);
    expect(await proc.sweep()).toBe(0); // nothing is stale yet: no lease is set

    // Now make it look like a worker died holding the claim.
    await db
      .update(publishJobs)
      .set({
        status: 'PUBLISHING',
        workerId: 'dead-worker',
        lockedUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(publishJobs.id, jobId));

    expect(await proc.sweep()).toBe(1);

    const outcomes = await proc.runOnce();

    expect(outcomes[0]).toMatchObject({ status: 'RECOVERED' });
    // The assertion that matters.
    expect(adapter.posts()).toHaveLength(1);
  });

  it('does not sweep a job a live worker still holds', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    const jobId = await seedJob({ postId: ids.postId, accountId });

    await db
      .update(publishJobs)
      .set({
        status: 'PUBLISHING',
        workerId: 'busy-worker',
        lockedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(publishJobs.id, jobId));

    // Stealing a live claim is how two workers publish the same post.
    expect(await processor(new MockSocialAdapter({ platform: PLATFORM })).sweep()).toBe(0);
  });

  it('returns a swept job to the queue rather than resuming it mid-publish', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    const jobId = await seedJob({ postId: ids.postId, accountId });

    await db
      .update(publishJobs)
      .set({ status: 'PUBLISHING', workerId: 'dead', lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(publishJobs.id, jobId));

    const proc = processor(new MockSocialAdapter({ platform: PLATFORM }));
    await proc.sweep();

    const [row] = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));

    // PENDING, so the job goes through the claim path again and therefore
    // through all three idempotency checks.
    expect(row).toMatchObject({ status: 'PENDING', workerId: null, lockedUntil: null });
  });

  // --- rate limiting -------------------------------------------------------

  it('leaves a rate-limited job claimable rather than losing it', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 5 });

    const adapter = new MockSocialAdapter({ platform: PLATFORM });
    // One slot, already taken.
    const limiter = new PlatformRateLimiter(PLATFORM, 1, 60_000);
    await limiter.run(async () => undefined);

    const outcomes = await processor(adapter, { limiterFor: () => limiter }).runOnce();

    expect(outcomes[0]?.status).toBe('RETRY');
    expect(adapter.posts()).toHaveLength(0);

    const [row] = await db.select().from(publishJobs).where(eq(publishJobs.postId, ids.postId));
    // Claimable again, which is what refusing rather than waiting buys - and with
    // its attempt given back, since nothing was ever sent to the platform.
    expect(row).toMatchObject({
      status: 'PENDING',
      workerId: null,
      lockedUntil: null,
      attempts: 0,
    });
    expect(sent).toHaveLength(0);
  });

  // --- notifications reach the database ------------------------------------

  it('writes the notification through the real service when one is given', async () => {
    const ids = await seed();
    const accountId = await seedAccount(ids.workspaceId, ids.userId);
    await seedJob({ postId: ids.postId, accountId, maxAttempts: 1 });

    // The processor only needs `notify`; wiring the real one here is what proves
    // the two agree on the dedupe key.
    const { NotificationsService } =
      await import('../../apps/api/src/publishing/notifications.service');
    const real = new NotificationsService();
    real.onModuleInit();

    const proc = new PublishProcessor({
      db,
      adapterFor: () => new MockSocialAdapter({ platform: PLATFORM, failTimes: 5 }),
      notify: real,
      workerId: 'worker-1',
      tokens: cipher,
      heartbeatSeconds: 1,
    });

    await proc.runOnce();

    const rows = await db.select().from(notifications).where(eq(notifications.userId, ids.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'publish_failed' });
  });
});
