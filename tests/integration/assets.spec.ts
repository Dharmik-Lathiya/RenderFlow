import { eq } from 'drizzle-orm';

import { assets } from '@renderflow/db';

import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { AssetsService } from '../../apps/api/src/workspaces/assets.service';
import { fakeStorage, type FakeStorage } from './helpers/fake-storage';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Asset upload and download (PROJECT.md section 12 Phase 3 DoD: "assets upload
 * and download").
 *
 * Bytes never pass through the API, so storage is a double here. What is being
 * tested is the part that IS real: the access check, the MIME and size
 * validation that happens before a URL is issued, and - crucially - that
 * `confirm` trusts `headObject` rather than the size the client declared.
 */
describe('assets: presigned upload and download', () => {
  let db: TestDb;
  let app: TestApp;
  let storage: FakeStorage;

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

    storage = fakeStorage();
    app.app.get(AssetsService).setStorage(storage);
  });

  async function owner(): Promise<{ token: string; workspaceId: string }> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('assets'), password: TEST_PASSWORD, name: 'Asset Owner' });

    const workspaces = await app
      .http()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${res.body.accessToken as string}`);

    return {
      token: res.body.accessToken as string,
      workspaceId: workspaces.body[0].id as string,
    };
  }

  it('issues a presigned PUT and records a pending asset', async () => {
    const me = await owner();

    const res = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 2048 });

    expect(res.status).toBe(201);
    expect(res.body.upload).toMatchObject({ method: 'PUT', expiresInSeconds: 900 });
    expect(res.body.upload.url).toContain('signature=');
    expect(res.body.asset).toMatchObject({
      workspaceId: me.workspaceId,
      mime: 'image/png',
      sizeBytes: 2048,
      type: 'IMAGE',
    });
    expect(res.body.asset.meta.status).toBe('PENDING_UPLOAD');
  });

  it('derives the object key from ids the caller cannot choose', async () => {
    const me = await owner();

    const res = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 10 });

    // A caller-supplied key could be aimed at another workspace's prefix or at an
    // existing object, so the server derives it.
    expect(res.body.asset.storageKey).toMatch(
      new RegExp(`^workspaces/${me.workspaceId}/assets/[0-9a-f-]{36}$`),
    );
  });

  it('refuses a MIME type that is not on the allow-list', async () => {
    const me = await owner();

    for (const mime of ['text/html', 'image/svg+xml', 'application/octet-stream']) {
      const res = await app
        .http()
        .post('/api/v1/assets/uploads')
        .set('Authorization', `Bearer ${me.token}`)
        .send({ workspaceId: me.workspaceId, mime, sizeBytes: 10 });

      expect(res.status).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('refuses a file over the size limit before issuing a URL', async () => {
    const me = await owner();

    const res = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'video/mp4', sizeBytes: 26 * 1024 * 1024 });

    // Refused up front: the client streams to S3 directly, so by the time
    // anything could measure the object the bytes have already been written.
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('ASSET_TOO_LARGE');
  });

  it('refuses an upload into a workspace the caller is not in', async () => {
    const mine = await owner();
    const theirs = await owner();

    const res = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ workspaceId: theirs.workspaceId, mime: 'image/png', sizeBytes: 10 });

    expect(res.status).toBe(403);
  });

  it('confirms an upload using the real object size, not the declared one', async () => {
    const me = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 10 });

    // The client declared 10 bytes but uploaded far more.
    storage.objects.set(created.body.asset.storageKey, {
      sizeBytes: 5000,
      contentType: 'image/png',
    });

    const res = await app
      .http()
      .post(`/api/v1/assets/${created.body.asset.id as string}/confirm`)
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(5000);
    expect(res.body.meta.status).toBe('READY');
  });

  it('refuses to confirm an object that is over the limit even if declared small', async () => {
    const me = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'video/mp4', sizeBytes: 10 });

    storage.objects.set(created.body.asset.storageKey, {
      sizeBytes: 40 * 1024 * 1024,
      contentType: 'video/mp4',
    });

    const res = await app
      .http()
      .post(`/api/v1/assets/${created.body.asset.id as string}/confirm`)
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(413);
  });

  it('returns a short-lived presigned download URL', async () => {
    const me = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 10 });

    const res = await app
      .http()
      .get(`/api/v1/assets/${created.body.asset.id as string}/download`)
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    expect(res.body.expiresInSeconds).toBe(300);
    // Short-lived on purpose: a permanent URL would outlive the membership check
    // that authorised it.
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(600);
  });

  it("refuses to download another workspace's asset", async () => {
    const mine = await owner();
    const theirs = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ workspaceId: theirs.workspaceId, mime: 'image/png', sizeBytes: 10 });

    const res = await app
      .http()
      .get(`/api/v1/assets/${created.body.asset.id as string}/download`)
      .set('Authorization', `Bearer ${mine.token}`);

    expect(res.status).toBe(403);
  });

  it('deletes the row and the object', async () => {
    const me = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 10 });

    const assetId = created.body.asset.id as string;
    const key = created.body.asset.storageKey as string;

    const res = await app
      .http()
      .delete(`/api/v1/assets/${assetId}`)
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(204);

    const rows = await db.select().from(assets).where(eq(assets.id, assetId));
    expect(rows).toHaveLength(0);
    expect(storage.objects.has(key)).toBe(false);
  });

  it('reports a clear 404 when confirming an upload that never landed', async () => {
    const me = await owner();

    const created = await app
      .http()
      .post('/api/v1/assets/uploads')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ workspaceId: me.workspaceId, mime: 'image/png', sizeBytes: 10 });

    storage.objects.delete(created.body.asset.storageKey as string);

    const res = await app
      .http()
      .post(`/api/v1/assets/${created.body.asset.id as string}/confirm`)
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(404);
  });

  it('rejects a non-uuid asset id instead of querying with it', async () => {
    const me = await owner();

    const res = await app
      .http()
      .get('/api/v1/assets/not-a-uuid/download')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(400);
  });
});
