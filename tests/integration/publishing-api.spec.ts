import { eq } from 'drizzle-orm';
import { AppError } from '@renderflow/common';
import {
  assets,
  brands,
  campaigns,
  outboxEvents,
  posts,
  publishJobs,
  socialAccounts,
  workspaces,
  workspaceMembers,
} from '@renderflow/db';

import { NotificationsService } from '../../apps/api/src/publishing/notifications.service';
import { PublishingService } from '../../apps/api/src/publishing/publishing.service';
import { SocialAccountsService } from '../../apps/api/src/publishing/social-accounts.service';
import { WorkspaceAccessService } from '../../apps/api/src/workspaces/workspace-access.service';
import { WorkspacesService } from '../../apps/api/src/workspaces/workspaces.service';

import { createUserWithBonus } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Scheduling as the API actually behaves it.
 *
 * Three properties are worth a real database rather than a mocked one, because
 * each lives in Postgres and not in TypeScript:
 *
 *  - tenancy, which is a WHERE clause on the workspace;
 *  - the approval gate, which reads a status another endpoint writes;
 *  - the all-or-nothing insert, whose mechanism is a partial unique index.
 */

const FUTURE_MINUTES = 60;

/**
 * "Exactly one row came back", which is what every fixture here means.
 *
 * `!` would say the same while proving nothing: the next line would throw about
 * destructuring instead of naming what was missing.
 */
function only<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`expected exactly one ${what}`);
  }

  return row;
}

/** `TOKEN_ENCRYPTION_KEY` is read at construction; a test key keeps it off the env. */
const TEST_KEY = Buffer.alloc(32, 3).toString('base64');

describe('publishing API', () => {
  let db: TestDb;
  let publishing: PublishingService;
  let accounts: SocialAccountsService;
  let notifier: NotificationsService;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    db = await setupTestDatabase();

    const access = new WorkspaceAccessService(new WorkspacesService());
    publishing = new PublishingService(access);
    accounts = new SocialAccountsService(access);
    notifier = new NotificationsService();

    for (const service of [publishing, accounts, notifier]) {
      service.onModuleInit();
    }
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
  });

  // --- fixtures ------------------------------------------------------------

  async function makeWorkspace(role: 'OWNER' | 'EDITOR' | 'APPROVER' | 'VIEWER' = 'OWNER') {
    const owner = await createUserWithBonus(db, { bonus: 50 });
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Acme', ownerId: owner.id })
      .returning({ id: workspaces.id });

    if (workspace === undefined) {
      throw new Error('no workspace');
    }

    // The owner's membership is a ROW, not a shortcut on `workspaces.owner_id` -
    // `membershipOf` only ever looks at `workspace_members`, so a fixture that
    // skips it looks like an access bug rather than a missing row.
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: owner.id,
      role: 'OWNER',
    });

    let memberId = owner.id;

    if (role !== 'OWNER') {
      const member = await createUserWithBonus(db, { bonus: 50 });
      memberId = member.id;
      await db
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: member.id, role });
    }

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

    if (brand === undefined) {
      throw new Error('no brand');
    }

    const [campaign] = await db
      .insert(campaigns)
      .values({ brandId: brand.id, goal: 'launch', status: 'ACTIVE', createdBy: owner.id })
      .returning({ id: campaigns.id });

    if (campaign === undefined) {
      throw new Error('no campaign');
    }

    return {
      ownerId: owner.id,
      memberId,
      workspaceId: workspace.id,
      brandId: brand.id,
      campaignId: campaign.id,
    };
  }

  async function makePost(
    ids: { campaignId: string; brandId: string },
    status: 'DRAFT' | 'APPROVED' = 'APPROVED',
    caption = 'Rain again.',
  ): Promise<string> {
    const [post] = await db
      .insert(posts)
      .values({
        campaignId: ids.campaignId,
        brandId: ids.brandId,
        type: 'CAPTION',
        caption,
        hashtags: '#weather',
        status,
      })
      .returning({ id: posts.id });

    if (post === undefined) {
      throw new Error('no post');
    }

    return post.id;
  }

  /**
   * Connects an account and returns its id.
   *
   * The external id is derived from the label, not the platform, so a test can
   * connect TWO accounts on the SAME platform - which is what a real workspace
   * looks like when it runs a company page and a personal one.
   */
  async function connectAccount(
    workspaceId: string,
    userId: string,
    platform: 'linkedin' | 'instagram' = 'linkedin',
    label = 'main',
  ) {
    const view = await accounts.connect(userId, {
      workspaceId,
      platform,
      externalAccountId: `${label}-ext`,
      displayName: 'Acme Ltd',
      accessToken: `token-for-${platform}-${label}`,
      scopes: ['publish'],
    });

    return view.id;
  }

  const inAnHour = () => new Date(Date.now() + FUTURE_MINUTES * 60_000);

  // --- the schedule --------------------------------------------------------

  it('schedules an approved post to a connected account', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    const result = await publishing.schedule(
      ids.ownerId,
      postId,
      {
        scheduledAt: inAnHour(),
        accountIds: [accountId],
      },
      undefined,
    );

    expect(result.replayed).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ platform: 'linkedin', status: 'SCHEDULED' });
  });

  it('stores the platform-formatted text, not the raw caption', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids, 'APPROVED', 'Rain again.');
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    const [row] = await db.select().from(publishJobs);

    // Hashtags appended here, at schedule time, not at publish time - so what
    // was approved is what goes out.
    expect(row?.platformContent).toBe('Rain again.\n\n#weather');
  });

  it('writes one outbox event per target', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const a = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'main');
    const b = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'second');

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a, b] },
      undefined,
    );

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'post.scheduled'));

    // One event for the whole post would give both targets a single queue entry
    // and BullMQ would drop one of them.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.aggregateId).every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it('gives every target its own queue entry', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const a = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'main');
    const b = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'second');

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a, b] },
      undefined,
    );

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'post.scheduled'));
    const jobIds = await db.select({ id: publishJobs.id }).from(publishJobs);

    // `aggregate_id` is the publish job, so the relay's deterministic
    // `generation:<aggregateId>` id is unique per target.
    expect(new Set(events.map((e) => e.aggregateId))).toEqual(new Set(jobIds.map((j) => j.id)));
  });

  // --- the approval gate ---------------------------------------------------

  it('refuses to schedule a draft', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids, 'DRAFT');
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    // Approving and scheduling are two steps on purpose: queueing must never be
    // the thing that reviews.
    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect(await db.select().from(publishJobs)).toHaveLength(0);
  });

  it('refuses a time in the past', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    // Almost always a client timezone bug, and "publish now" is a different
    // thing to ask for.
    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: new Date(Date.now() - 60_000), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  // --- tenancy -------------------------------------------------------------

  it('refuses an account from another workspace', async () => {
    const mine = await makeWorkspace();
    const theirs = await makeWorkspace();

    const postId = await makePost(mine);
    const theirAccountId = await connectAccount(theirs.workspaceId, theirs.ownerId);

    // The whole tenancy story for this endpoint: without the workspace filter on
    // the accounts, an APPROVER of workspace A could publish workspace A's post
    // from workspace B's profile.
    await expect(
      publishing.schedule(
        mine.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [theirAccountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect(await db.select().from(publishJobs)).toHaveLength(0);
  });

  it('gives a missing account and a foreign account the same error', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const real = await connectAccount(ids.workspaceId, ids.ownerId);

    const onForeign = await publishing
      .schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: ['11111111-1111-4111-8111-111111111111'] },
        undefined,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    await db.delete(publishJobs);
    await db.delete(socialAccounts).where(eq(socialAccounts.id, real));

    const onMissing = await publishing
      .schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: ['11111111-1111-4111-8111-111111111111'] },
        undefined,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    // A caller who can tell the two apart learns which ids exist elsewhere.
    expect(String(onForeign)).toBe(String(onMissing));
  });

  it('refuses a caller from another workspace entirely', async () => {
    const mine = await makeWorkspace();
    const theirs = await makeWorkspace();
    const postId = await makePost(mine);
    const accountId = await connectAccount(mine.workspaceId, mine.ownerId);

    await expect(
      publishing.schedule(
        theirs.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('needs APPROVER, not EDITOR', async () => {
    const ids = await makeWorkspace('EDITOR');
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.memberId);

    // Publishing to a public profile is the most privileged act in the product.
    await expect(
      publishing.schedule(
        ids.memberId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  // --- duplicates ----------------------------------------------------------

  it('refuses a second schedule to the same account', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect(await db.select().from(publishJobs)).toHaveLength(1);
  });

  it('answers a retried Idempotency-Key with the schedule it already made', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const a = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'main');
    const b = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'second');

    const first = await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a, b] },
      'key-1',
    );
    const second = await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a, b] },
      'key-1',
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.jobs.map((j) => j.id).sort()).toEqual(first.jobs.map((j) => j.id).sort());
    // Two accounts, two rows - a single stored key would have collided with
    // itself on the unique index.
    expect(await db.select().from(publishJobs)).toHaveLength(2);
  });

  it('rolls the whole schedule back when one target is already queued', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const a = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'main');
    const b = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'second');

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a] },
      undefined,
    );

    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [a, b] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);

    // Not two rows where the second one is silently missing `b`.
    const rows = await db.select().from(publishJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.socialAccountId).toBe(a);
    // And no orphan outbox event for a job that does not exist.
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it('lets a failed publish be rescheduled', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    await db
      .update(publishJobs)
      .set({ status: 'FAILED', error: 'platform outage' })
      .where(eq(publishJobs.postId, postId));

    const again = await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    // Blocking on a terminal row would make a post impossible to reschedule,
    // which is exactly what someone wants after an outage.
    expect(again.jobs).toHaveLength(1);
  });

  // --- platform rules at schedule time -------------------------------------

  it('refuses a text-only Instagram post up front', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId, 'instagram');

    // Caught here rather than as a 400 from the platform an hour later, after the
    // user was told it was queued.
    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect(await db.select().from(publishJobs)).toHaveLength(0);
  });

  it('allows a text-only Instagram post that has media', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId, 'instagram');

    await db.insert(assets).values({
      postId,
      workspaceId: ids.workspaceId,
      type: 'IMAGE',
      storageKey: 'brands/acme/poster.png',
      mime: 'image/png',
      sizeBytes: 1024,
      meta: { status: 'READY' },
    });

    const result = await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    expect(result.jobs).toHaveLength(1);
  });

  it('will not publish an asset whose upload was never confirmed', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId, 'instagram');

    // The row is written BEFORE the upload so the presigned URL can name the
    // object, so a row can exist with nothing behind it.
    await db.insert(assets).values({
      postId,
      workspaceId: ids.workspaceId,
      type: 'IMAGE',
      storageKey: 'brands/acme/never-uploaded.png',
      mime: 'image/png',
      sizeBytes: 1024,
      meta: {},
    });

    await expect(
      publishing.schedule(
        ids.ownerId,
        postId,
        { scheduledAt: inAnHour(), accountIds: [accountId] },
        undefined,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  // --- cancel --------------------------------------------------------------

  it('cancels only what has not started', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const a = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'main');
    const b = await connectAccount(ids.workspaceId, ids.ownerId, 'linkedin', 'second');

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [a, b] },
      undefined,
    );

    // One is mid-flight at the platform; there is no calling that back.
    await db
      .update(publishJobs)
      .set({ status: 'PUBLISHING' })
      .where(eq(publishJobs.socialAccountId, b));

    const result = await publishing.cancel(ids.ownerId, postId);

    expect(result.cancelled).toBe(1);
    const rows = await db.select().from(publishJobs);
    expect(rows.find((r) => r.socialAccountId === a)?.status).toBe('FAILED');
    expect(rows.find((r) => r.socialAccountId === b)?.status).toBe('PUBLISHING');
  });

  // --- social accounts -----------------------------------------------------

  it('never returns a token', async () => {
    const ids = await makeWorkspace();
    await connectAccount(ids.workspaceId, ids.ownerId);

    const listed = await accounts.list(ids.ownerId, ids.workspaceId);

    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('token-for-linkedin');
    expect(Object.keys(listed[0] ?? {})).not.toContain('token');
  });

  it('stores the token encrypted', async () => {
    const ids = await makeWorkspace();
    await connectAccount(ids.workspaceId, ids.ownerId);

    const [row] = await db.select().from(socialAccounts);

    // A database backup, a replica, a `psql` session - any of those is a file
    // that ends up somewhere it should not.
    expect(row?.token).not.toContain('token-for-linkedin');
    expect(row?.token.startsWith('v1.')).toBe(true);
  });

  it('rotates the token on reconnect rather than adding a row', async () => {
    const ids = await makeWorkspace();
    const first = await connectAccount(ids.workspaceId, ids.ownerId);

    // The SAME platform account: `connectAccount` names it by label, so the
    // reconnect has to use that same label or it is legitimately a different
    // account and a second row is the correct answer.
    const second = await accounts.connect(ids.ownerId, {
      workspaceId: ids.workspaceId,
      platform: 'linkedin',
      externalAccountId: 'main-ext',
      displayName: 'Acme Ltd',
      accessToken: 'token-rotated',
      scopes: ['publish'],
    });

    // Two rows would leave publish picking between them at random, and half the
    // posts would go out under the revoked token.
    expect(second.id).toBe(first);
    expect(await db.select().from(socialAccounts)).toHaveLength(1);
  });

  it('refuses to disconnect an account with posts still queued', async () => {
    const ids = await makeWorkspace();
    const postId = await makePost(ids);
    const accountId = await connectAccount(ids.workspaceId, ids.ownerId);

    await publishing.schedule(
      ids.ownerId,
      postId,
      { scheduledAt: inAnHour(), accountIds: [accountId] },
      undefined,
    );

    // Deleting the row would cascade-delete the jobs with it, so a post scheduled
    // for an hour from now would vanish from the calendar instead of failing
    // visibly.
    await expect(accounts.disconnect(ids.ownerId, accountId)).rejects.toBeInstanceOf(AppError);
  });

  it('flags an expired token for reconnect', async () => {
    const ids = await makeWorkspace();
    await accounts.connect(ids.ownerId, {
      workspaceId: ids.workspaceId,
      platform: 'linkedin',
      externalAccountId: 'main-ext',
      accessToken: 'old',
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const listed = await accounts.list(ids.ownerId, ids.workspaceId);

    // What tells the UI to prompt for a reconnect instead of letting a user
    // watch a scheduled post fail.
    expect(listed[0]?.needsReconnect).toBe(true);
  });

  // --- notifications -------------------------------------------------------

  it('lists notifications newest first and marks them read', async () => {
    const ids = await makeWorkspace();

    await notifier.notify({
      userId: ids.ownerId,
      type: 'publish_failed',
      title: 'One',
      body: 'first',
    });
    await notifier.notify({
      userId: ids.ownerId,
      type: 'credits_low',
      title: 'Two',
      body: 'second',
    });

    const listed = await notifier.list(ids.ownerId);
    expect(listed.map((n) => n.title)).toEqual(['Two', 'One']);
    expect(await notifier.countUnread(ids.ownerId)).toBe(2);

    const marked = await notifier.markRead(ids.ownerId, only(listed[0], 'notification').id);
    expect(marked.updated).toBe(true);
    expect(await notifier.countUnread(ids.ownerId)).toBe(1);
  });

  it('tells the user once about a publish that failed three times', async () => {
    const ids = await makeWorkspace();

    // A centre full of duplicates is a centre people learn to ignore, which
    // defeats the purpose of having one.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await notifier.notify({
        userId: ids.ownerId,
        type: 'publish_failed',
        title: 'Post did not publish',
        body: `attempt ${attempt}`,
        dedupeKey: 'publish-job-1',
      });
    }

    const listed = await notifier.list(ids.ownerId);
    expect(listed).toHaveLength(1);
    // The body is the part that changes between retries, so it is the part that
    // has to be refreshed.
    expect(listed[0]?.body).toBe('attempt 3');
  });

  it("will not mark someone else's notification read", async () => {
    const mine = await makeWorkspace();
    const theirs = await makeWorkspace();

    await notifier.notify({
      userId: theirs.ownerId,
      type: 'publish_failed',
      title: 'Theirs',
      body: 'x',
    });
    const theirList = await notifier.list(theirs.ownerId);

    // Otherwise this is an endpoint where any caller can mark any notification
    // read by guessing a uuid - and it reports success for rows that are not
    // theirs.
    const result = await notifier.markRead(mine.ownerId, only(theirList[0], 'notification').id);
    expect(result.updated).toBe(false);
    expect(await notifier.countUnread(theirs.ownerId)).toBe(1);
  });

  it('keeps undedupable notifications separate', async () => {
    const ids = await makeWorkspace();

    // A plain unique index over a nullable column treats every NULL as equal, so
    // the first undedupable notification would block all the others.
    await notifier.notify({ userId: ids.ownerId, type: 'credits_low', title: 'A', body: 'a' });
    await notifier.notify({ userId: ids.ownerId, type: 'credits_low', title: 'B', body: 'b' });

    expect(await notifier.list(ids.ownerId)).toHaveLength(2);
  });
});
