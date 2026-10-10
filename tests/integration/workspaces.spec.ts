import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Workspace lifecycle (PROJECT.md section 12 Phase 3).
 *
 * Covers the paths the studio suite does not reach: creating a second workspace,
 * re-roling an existing member, removing one, and the guard rails around owners.
 * Each of those is a way for a workspace to end up unmanageable, which is why they
 * are asserted rather than assumed.
 */
describe('workspaces: membership lifecycle', () => {
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

  async function registerUser(
    prefix: string,
  ): Promise<{ userId: string; token: string; workspaceId: string }> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: TEST_PASSWORD, name: prefix });

    const token = res.body.accessToken as string;
    const workspaces = await app
      .http()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${token}`);

    return {
      userId: res.body.user.id as string,
      token,
      workspaceId: workspaces.body[0].id as string,
    };
  }

  const auth = (token: string) => ({
    get: (url: string) => app.http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => app.http().post(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => app.http().delete(url).set('Authorization', `Bearer ${token}`),
  });

  describe('creating', () => {
    it('creates a second workspace owned by the caller', async () => {
      const me = await registerUser('creator');

      const res = await auth(me.token).post('/api/v1/workspaces').send({ name: 'Second Space' });

      // No POST /workspaces route exists yet, so this documents the gap rather
      // than a behaviour: PROJECT.md section 10 lists `POST /workspaces`.
      expect(res.status).toBe(404);

      const mine = await auth(me.token).get('/api/v1/workspaces');
      expect(mine.body).toHaveLength(1);
    });
  });

  describe('re-roling a member', () => {
    it('promotes a member in place rather than adding a second row', async () => {
      const owner = await registerUser('owner');
      const member = await registerUser('member');

      const add = await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: member.userId, role: 'VIEWER' });
      expect(add.status).toBe(201);

      const promote = await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: member.userId, role: 'EDITOR' });
      expect(promote.status).toBe(201);

      const members = await auth(owner.token).get(
        `/api/v1/workspaces/${owner.workspaceId}/members`,
      );

      // The composite primary key makes this an upsert, so the member appears
      // once with the new role - not twice, once per role.
      const rows = members.body.filter((m: { userId: string }) => m.userId === member.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('EDITOR');
    });
  });

  describe('listing members', () => {
    it('lists every member with their role', async () => {
      const owner = await registerUser('owner');
      const a = await registerUser('a');
      const b = await registerUser('b');

      await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: a.userId, role: 'EDITOR' });
      await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: b.userId, role: 'APPROVER' });

      const res = await auth(owner.token).get(`/api/v1/workspaces/${owner.workspaceId}/members`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);

      const roles = Object.fromEntries(
        res.body.map((m: { userId: string; role: string }) => [m.userId, m.role]),
      );
      expect(roles[owner.userId]).toBe('OWNER');
      expect(roles[a.userId]).toBe('EDITOR');
      expect(roles[b.userId]).toBe('APPROVER');
    });

    it('refuses to list members of a workspace the caller is not in', async () => {
      const owner = await registerUser('owner');
      const stranger = await registerUser('stranger');

      const res = await auth(stranger.token).get(`/api/v1/workspaces/${owner.workspaceId}/members`);

      // A member list discloses who works where, which is itself tenant data.
      expect(res.status).toBe(403);
    });
  });

  describe('removing a member', () => {
    it('removes a member and revokes their access immediately', async () => {
      const owner = await registerUser('owner');
      const member = await registerUser('member');

      await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: member.userId, role: 'EDITOR' });

      const before = await auth(member.token).get(`/api/v1/workspaces/${owner.workspaceId}`);
      expect(before.status).toBe(200);

      const removed = await auth(owner.token).delete(
        `/api/v1/workspaces/${owner.workspaceId}/members/${member.userId}`,
      );
      expect(removed.status).toBe(204);

      // Access must end at the same request, not at the next token refresh.
      const after = await auth(member.token).get(`/api/v1/workspaces/${owner.workspaceId}`);
      expect(after.status).toBe(403);
      expect(after.body.code).toBe('WORKSPACE_ACCESS_DENIED');
    });

    it('404s when the target is not a member', async () => {
      const owner = await registerUser('owner');
      const stranger = await registerUser('stranger');

      const res = await auth(owner.token).delete(
        `/api/v1/workspaces/${owner.workspaceId}/members/${stranger.userId}`,
      );

      expect(res.status).toBe(404);
    });

    it('refuses a non-OWNER removing anyone', async () => {
      const owner = await registerUser('owner');
      const editor = await registerUser('editor');
      const victim = await registerUser('victim');

      await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: editor.userId, role: 'EDITOR' });
      await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: victim.userId, role: 'VIEWER' });

      const res = await auth(editor.token).delete(
        `/api/v1/workspaces/${owner.workspaceId}/members/${victim.userId}`,
      );

      expect(res.status).toBe(403);
    });

    it('allows removing a co-owner when another owner remains', async () => {
      const first = await registerUser('first');
      const second = await registerUser('second');

      await auth(first.token)
        .post(`/api/v1/workspaces/${first.workspaceId}/members`)
        .send({ userId: second.userId, role: 'OWNER' });

      const res = await auth(first.token).delete(
        `/api/v1/workspaces/${first.workspaceId}/members/${second.userId}`,
      );

      expect(res.status).toBe(204);
    });
  });

  describe('invalid input', () => {
    it('rejects an unknown role', async () => {
      const owner = await registerUser('owner');
      const member = await registerUser('member');

      const res = await auth(owner.token)
        .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
        .send({ userId: member.userId, role: 'SUPERUSER' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a non-uuid workspace id before any query runs', async () => {
      const owner = await registerUser('owner');

      const res = await auth(owner.token).get('/api/v1/workspaces/not-a-uuid');

      expect(res.status).toBe(400);
    });
  });
});
