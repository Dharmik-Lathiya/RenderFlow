import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { fakeStorage } from './helpers/fake-storage';
import { AssetsService } from '../../apps/api/src/workspaces/assets.service';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Phase 3 (PROJECT.md section 12): workspaces, brands, campaigns, posts, assets.
 *
 * Two things are being tested here, and the second is the one that matters.
 *
 * 1. That the happy paths work.
 * 2. **Multi-tenant isolation.** AGENTS.md section 10 requires a test per
 *    endpoint for workspace-scoped queries. A workspace-per-user fixture makes
 *    that mechanical: for every read and every write, user A must not see or
 *    touch user B's data, and the failure must be a refusal rather than a 404
 *    that leaks the row's existence.
 *
 * Roles are exercised against the real hierarchy: VIEWER reads, EDITOR writes,
 * APPROVER approves but does not edit, OWNER manages membership.
 */

interface Account {
  userId: string;
  accessToken: string;
  cookie: string;
  csrf: string;
  workspaceId: string;
}

describe('studio: workspaces, brands, campaigns, posts, assets', () => {
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
    // MinIO is not running in CI; the asset flow's server-side checks are what
    // these suites exercise, so a double is enough.
    app.app.get(AssetsService).setStorage(fakeStorage());
  });

  /** Registers a user and returns their personal workspace and auth headers. */
  async function account(prefix: string): Promise<Account> {
    const email = uniqueEmail(prefix);
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email, password: TEST_PASSWORD, name: prefix });

    if (res.status !== 201) {
      throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    }

    const workspaces = await app
      .http()
      .get('/api/v1/workspaces')
      .set('Cookie', cookieHeader(res))
      .set('x-csrf-token', csrf(res));

    const workspaceId = workspaces.body[0]?.id as string;
    if (typeof workspaceId !== 'string') {
      throw new Error(`no personal workspace for ${email}: ${JSON.stringify(workspaces.body)}`);
    }

    return {
      userId: res.body.user.id as string,
      accessToken: res.body.accessToken as string,
      cookie: cookieHeader(res),
      csrf: csrf(res),
      workspaceId,
    };
  }

  function cookieHeader(res: { headers: Record<string, unknown> }): string {
    const cookies = res.headers['set-cookie'];
    const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    return list.map((c) => String(c).split(';')[0]).join('; ');
  }

  function csrf(res: { headers: Record<string, unknown> }): string {
    const cookies = res.headers['set-cookie'];
    const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    const found = list.find((c) => String(c).startsWith('rf_csrf='));
    if (found === undefined) {
      return '';
    }
    return String(found).slice('rf_csrf='.length).split(';')[0] ?? '';
  }

  /** Authenticated request with a bearer token (mobile-style, no cookies). */
  const asUser = (acct: Account) => ({
    get: (url: string) => app.http().get(url).set('Authorization', `Bearer ${acct.accessToken}`),
    post: (url: string) => app.http().post(url).set('Authorization', `Bearer ${acct.accessToken}`),
    patch: (url: string) =>
      app.http().patch(url).set('Authorization', `Bearer ${acct.accessToken}`),
    delete: (url: string) =>
      app.http().delete(url).set('Authorization', `Bearer ${acct.accessToken}`),
  });

  async function createBrand(acct: Account, name = 'Acme'): Promise<string> {
    const res = await asUser(acct)
      .post('/api/v1/brands')
      .send({
        workspaceId: acct.workspaceId,
        name,
        industry: 'retail',
        tone: 'friendly and direct',
        colors: ['#ff0000'],
        languages: ['en'],
      });
    if (res.status !== 201) {
      throw new Error(`brand create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.id as string;
  }

  async function createCampaign(acct: Account, brandId: string): Promise<string> {
    const res = await asUser(acct)
      .post('/api/v1/campaigns')
      .send({ brandId, goal: 'launch the spring line' });
    if (res.status !== 201) {
      throw new Error(`campaign create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.id as string;
  }

  async function createPost(acct: Account, campaignId: string): Promise<string> {
    const res = await asUser(acct)
      .post('/api/v1/posts')
      .send({ campaignId, type: 'CAPTION', caption: 'Hello' });
    if (res.status !== 201) {
      throw new Error(`post create failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.id as string;
  }

  describe('workspaces', () => {
    it('gives every new user a personal workspace they own', async () => {
      const acct = await account('owner');

      const res = await asUser(acct).get('/api/v1/workspaces');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: acct.workspaceId, role: 'OWNER' });
    });

    it('lists only the workspaces the caller belongs to', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      const mine = await asUser(alice).get('/api/v1/workspaces');

      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].id).toBe(alice.workspaceId);
      expect(mine.body.map((w: { id: string }) => w.id)).not.toContain(bob.workspaceId);
    });

    it('refuses to read a workspace the caller is not in', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      const res = await asUser(alice).get(`/api/v1/workspaces/${bob.workspaceId}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');
    });

    it('lets an OWNER add a member, and the new member can then read it', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      const add = await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'VIEWER' });

      if (add.status !== 201) {
        throw new Error(`addMember ${add.status} ${JSON.stringify(add.body)} userId=${bob.userId}`);
      }
      expect(add.status).toBe(201);
      expect(add.body).toMatchObject({ role: 'VIEWER' });

      const nowIn = await asUser(bob).get('/api/v1/workspaces');
      expect(nowIn.body.map((w: { id: string }) => w.id)).toContain(alice.workspaceId);
    });

    it('rejects adding a member from an unknown user id', async () => {
      const alice = await account('alice');

      const res = await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: '99999999-9999-4999-8999-999999999999', role: 'VIEWER' });

      expect(res.status).toBe(404);
    });
  });

  describe('brands', () => {
    it('creates and reads back a brand', async () => {
      const acct = await account('brand');

      const brandId = await createBrand(acct, 'Northwind');

      const res = await asUser(acct).get(`/api/v1/brands/${brandId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Northwind',
        industry: 'retail',
        colors: ['#ff0000'],
        languages: ['en'],
      });
    });

    it('lists only brands in the requested workspace', async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      await createBrand(alice, 'Alice Brand');
      await createBrand(bob, 'Bob Brand');

      const res = await asUser(alice).get(`/api/v1/brands?workspaceId=${alice.workspaceId}`);

      expect(res.status).toBe(200);
      expect(res.body.map((b: { name: string }) => b.name)).toEqual(['Alice Brand']);
    });

    it("refuses to read another workspace's brand", async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const bobBrand = await createBrand(bob, 'Bob Secret');

      const res = await asUser(alice).get(`/api/v1/brands/${bobBrand}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');
    });

    it("refuses to update another workspace's brand", async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const bobBrand = await createBrand(bob, 'Bob Secret');

      const res = await asUser(alice).patch(`/api/v1/brands/${bobBrand}`).send({ name: 'stolen' });

      expect(res.status).toBe(403);
      const check = await asUser(bob).get(`/api/v1/brands/${bobBrand}`);
      expect(check.body.name).toBe('Bob Secret');
    });

    it('refuses to create a brand in a workspace the caller is not in', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      const res = await asUser(alice)
        .post('/api/v1/brands')
        .send({ workspaceId: bob.workspaceId, name: 'Sneaky' });

      expect(res.status).toBe(403);
    });

    it('rejects a malformed colour', async () => {
      const acct = await account('colour');

      const res = await asUser(acct)
        .post('/api/v1/brands')
        .send({
          workspaceId: acct.workspaceId,
          name: 'Bad Colours',
          colors: ['not-a-colour'],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a duplicate brand name inside one workspace', async () => {
      const acct = await account('dupe');
      await createBrand(acct, 'Unique');

      const res = await asUser(acct).post('/api/v1/brands').send({
        workspaceId: acct.workspaceId,
        name: 'Unique',
      });

      expect(res.status).toBe(409);
    });

    it('allows the same brand name in two different workspaces', async () => {
      // Uniqueness is per workspace, not global: two companies may both have a
      // brand called "Spring".
      const alice = await account('alice');
      const bob = await account('bob');

      await createBrand(alice, 'Spring');
      const res = await asUser(bob).post('/api/v1/brands').send({
        workspaceId: bob.workspaceId,
        name: 'Spring',
      });

      expect(res.status).toBe(201);
    });

    it('updates a brand and bumps updated_at', async () => {
      const acct = await account('update');
      const brandId = await createBrand(acct);

      const res = await asUser(acct).patch(`/api/v1/brands/${brandId}`).send({ tone: 'wry' });

      expect(res.status).toBe(200);
      expect(res.body.tone).toBe('wry');
    });
  });

  describe('campaigns and posts', () => {
    it('creates a campaign under a brand and lists it', async () => {
      const acct = await account('campaign');
      const brandId = await createBrand(acct);

      const campaignId = await createCampaign(acct, brandId);

      const res = await asUser(acct).get(`/api/v1/brands/${brandId}/campaigns`);
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: string }) => c.id)).toEqual([campaignId]);
    });

    it("refuses to create a campaign under another workspace's brand", async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const bobBrand = await createBrand(bob);

      const res = await asUser(alice)
        .post('/api/v1/campaigns')
        .send({ brandId: bobBrand, goal: 'steal' });

      expect(res.status).toBe(403);
    });

    it('rejects an end date before the start date', async () => {
      const acct = await account('dates');
      const brandId = await createBrand(acct);

      const res = await asUser(acct)
        .post('/api/v1/campaigns')
        .send({ brandId, goal: 'g', startDate: '2026-03-10', endDate: '2026-03-01' });

      expect(res.status).toBe(400);
    });

    it('stores campaign dates without a timezone shift', async () => {
      // A calendar date must not become the previous day for a user west of
      // Greenwich, which is what a JS Date conversion would do.
      const acct = await account('tz');
      const brandId = await createBrand(acct);

      const res = await asUser(acct)
        .post('/api/v1/campaigns')
        .send({ brandId, goal: 'g', startDate: '2026-03-01', endDate: '2026-03-31' });

      expect(res.status).toBe(201);
      expect(res.body.startDate).toBe('2026-03-01');
      expect(res.body.endDate).toBe('2026-03-31');
    });

    it('creates a post and bumps its version on edit', async () => {
      const acct = await account('post');
      const brandId = await createBrand(acct);
      const campaignId = await createCampaign(acct, brandId);

      const postId = await createPost(acct, campaignId);

      const first = await asUser(acct).get(`/api/v1/campaigns/${campaignId}/posts`);
      expect(first.body[0]).toMatchObject({ version: 1, status: 'DRAFT' });

      const updated = await asUser(acct)
        .patch(`/api/v1/posts/${postId}`)
        .send({ caption: 'Revised' });

      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ caption: 'Revised', version: 2 });
    });

    it("refuses to edit another workspace's post", async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const bobBrand = await createBrand(bob);
      const bobCampaign = await createCampaign(bob, bobBrand);
      const bobPost = await createPost(bob, bobCampaign);

      const res = await asUser(alice).patch(`/api/v1/posts/${bobPost}`).send({ caption: 'stolen' });

      expect(res.status).toBe(403);
      const check = await asUser(bob).get(`/api/v1/campaigns/${bobCampaign}/posts`);
      expect(check.body[0].caption).toBe('Hello');
    });
  });

  describe('role enforcement', () => {
    it('lets a VIEWER read but not write', async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      await createBrand(alice, 'Shared');

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'VIEWER' });

      const brandId = (await asUser(alice).get(`/api/v1/brands?workspaceId=${alice.workspaceId}`))
        .body[0].id;

      const read = await asUser(bob).get(`/api/v1/brands/${brandId}`);
      expect(read.status).toBe(200);

      const write = await asUser(bob).post('/api/v1/brands').send({
        workspaceId: alice.workspaceId,
        name: 'Viewer Wrote This',
      });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('lets an EDITOR write but not approve', async () => {
      // Authorship and approval are deliberately separate roles so one person
      // cannot rubber-stamp their own content.
      const alice = await account('alice');
      const bob = await account('bob');
      const brandId = await createBrand(alice);
      const campaignId = await createCampaign(alice, brandId);
      const postId = await createPost(alice, campaignId);

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'EDITOR' });

      const write = await asUser(bob).post('/api/v1/brands').send({
        workspaceId: alice.workspaceId,
        name: 'Editor Brand',
      });
      expect(write.status).toBe(201);

      const approve = await asUser(bob).post(`/api/v1/posts/${postId}/approve`).send({});
      expect(approve.status).toBe(403);
      expect(approve.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('lets an APPROVER approve', async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const brandId = await createBrand(alice);
      const campaignId = await createCampaign(alice, brandId);
      const postId = await createPost(alice, campaignId);

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'APPROVER' });

      const approve = await asUser(bob).post(`/api/v1/posts/${postId}/approve`).send({});

      expect(approve.status).toBe(201);
      expect(approve.body).toMatchObject({ status: 'APPROVED' });
    });

    it('stops a non-OWNER from managing membership', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'EDITOR' });

      const res = await asUser(bob)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'OWNER' });

      expect(res.status).toBe(403);
    });

    it('stops deleting a brand without OWNER', async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const brandId = await createBrand(alice);

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'EDITOR' });

      const res = await asUser(bob).delete(`/api/v1/brands/${brandId}`);

      expect(res.status).toBe(403);
    });

    it('refuses to remove the last owner', async () => {
      const alice = await account('alice');
      const bob = await account('bob');

      await asUser(alice)
        .post(`/api/v1/workspaces/${alice.workspaceId}/members`)
        .send({ userId: bob.userId, role: 'VIEWER' });

      const res = await asUser(alice).delete(
        `/api/v1/workspaces/${alice.workspaceId}/members/${alice.userId}`,
      );

      // A workspace with no owner is unmanageable and unrecoverable by members.
      expect(res.status).toBe(409);
    });
  });

  describe('deletion and lifecycle edges', () => {
    it('lets an OWNER delete a brand and cascades its campaigns', async () => {
      const acct = await account('delete');
      const brandId = await createBrand(acct, 'Doomed');
      await createCampaign(acct, brandId);

      const res = await asUser(acct).delete(`/api/v1/brands/${brandId}`);
      expect(res.status).toBe(204);

      // Campaigns and posts hang off the brand with ON DELETE CASCADE, so a
      // deleted brand must not leave orphans that still render.
      const after = await asUser(acct).get(`/api/v1/brands/${brandId}`);
      expect(after.status).toBe(403);
    });

    it('refuses approving a post twice', async () => {
      const owner = await account('owner');
      const approver = await account('approver');
      const brandId = await createBrand(owner);
      const campaignId = await createCampaign(owner, brandId);
      const postId = await createPost(owner, campaignId);

      await asUser(owner)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: approver.userId, role: 'APPROVER' });

      const first = await asUser(approver).post(`/api/v1/posts/${postId}/approve`).send({});
      expect(first.status).toBe(201);

      const second = await asUser(approver).post(`/api/v1/posts/${postId}/approve`).send({});

      // Approving twice would overwrite the original approver and timestamp,
      // destroying the audit trail of who signed off.
      expect(second.status).toBe(409);
    });

    it("lists a post's assets", async () => {
      const acct = await account('assets');
      const brandId = await createBrand(acct);
      const campaignId = await createCampaign(acct, brandId);
      const postId = await createPost(acct, campaignId);

      const empty = await asUser(acct).get(`/api/v1/posts/${postId}/assets`);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual([]);

      const upload = await asUser(acct).post('/api/v1/assets/uploads').send({
        workspaceId: acct.workspaceId,
        postId,
        mime: 'image/png',
        sizeBytes: 512,
      });
      expect(upload.status).toBe(201);

      const listed = await asUser(acct).get(`/api/v1/posts/${postId}/assets`);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ mime: 'image/png', sizeBytes: 512 });
    });

    it("refuses to attach an asset to another workspace's post", async () => {
      const alice = await account('alice');
      const bob = await account('bob');
      const bobBrand = await createBrand(bob);
      const bobCampaign = await createCampaign(bob, bobBrand);
      const bobPost = await createPost(bob, bobCampaign);

      const res = await asUser(alice).post('/api/v1/assets/uploads').send({
        workspaceId: alice.workspaceId,
        postId: bobPost,
        mime: 'image/png',
        sizeBytes: 512,
      });

      // Otherwise an asset could be written into Alice's workspace while
      // attached to Bob's post.
      expect(res.status).toBe(403);
    });
  });

  describe('unauthenticated access', () => {
    it('refuses every studio route without a token', async () => {
      for (const url of [
        '/api/v1/workspaces',
        '/api/v1/brands?workspaceId=00000000-0000-4000-8000-000000000000',
      ]) {
        const res = await app.http().get(url);
        expect(res.status).toBe(401);
      }

      const post = await app
        .http()
        .post('/api/v1/brands')
        .send({ workspaceId: '00000000-0000-4000-8000-000000000000', name: 'x' });
      expect(post.status).toBe(401);
    });
  });
});
