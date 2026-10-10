import {
  OPENAPI_JSON_PATH,
  resetOpenApiDocument,
  setupOpenApi,
} from '../../apps/api/src/common/openapi';
import { createTestApp } from './helpers/app-harness';

/**
 * OpenAPI document (PROJECT.md section 12 Phase 3 DoD: "OpenAPI docs
 * generated").
 *
 * This is a contract test. It asserts that the routes the spec documents in
 * PROJECT.md section 10 actually exist in the generated document, so the two
 * cannot drift: a renamed or dropped endpoint fails here rather than surprising
 * a client built against the document.
 */
describe('OpenAPI document', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let document: {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, unknown>>;
    components?: { securitySchemes?: Record<string, unknown> };
  };

  beforeAll(async () => {
    app = await createTestApp();
    // The document is process-global, so a previous suite's routes must not leak
    // into this one.
    resetOpenApiDocument();
    setupOpenApi(app.app, { mountUi: false });
    const res = await app.http().get(`/${OPENAPI_JSON_PATH}`);
    document = res.body;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is served and is a valid OpenAPI 3 document', async () => {
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('RenderFlow API');
  });

  it('documents every auth route from PROJECT.md section 10', () => {
    for (const path of [
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
  });

  it('documents every studio route', () => {
    for (const path of [
      '/api/v1/workspaces',
      '/api/v1/workspaces/{workspaceId}',
      '/api/v1/workspaces/{workspaceId}/members',
      '/api/v1/brands',
      '/api/v1/brands/{brandId}',
      '/api/v1/brands/{brandId}/campaigns',
      '/api/v1/campaigns',
      '/api/v1/posts',
      '/api/v1/posts/{postId}',
      '/api/v1/posts/{postId}/approve',
      '/api/v1/posts/{postId}/assets',
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
  });

  it('documents the asset upload and download flow', () => {
    expect(document.paths['/api/v1/assets/uploads']).toBeDefined();
    expect(document.paths['/api/v1/assets/{assetId}/download']).toBeDefined();
    expect(document.paths['/api/v1/assets/{assetId}/confirm']).toBeDefined();
    expect(document.paths['/api/v1/assets/{assetId}']).toBeDefined();
  });

  it('documents the read endpoints from Phase 1 and 2', () => {
    for (const path of ['/api/v1/me', '/api/v1/credits', '/api/v1/auth/me']) {
      expect(document.paths[path]).toBeDefined();
    }
  });

  it('documents the health and metrics routes', () => {
    expect(document.paths['/health/live']).toBeDefined();
    expect(document.paths['/health/ready']).toBeDefined();
    expect(document.paths['/metrics']).toBeDefined();
  });

  it('declares both cookie and bearer authentication', () => {
    const schemes = document.components?.securitySchemes ?? {};
    // The web app authenticates by cookie; mobile by header. A document that only
    // described one of them would generate a client that cannot work.
    expect(Object.keys(schemes)).toEqual(expect.arrayContaining(['cookie', 'bearer']));
  });

  it('gives every documented operation a summary', () => {
    // `@nestjs/swagger` emits an empty object for an undecorated handler, which
    // renders as a blank row in the UI.
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) {
          continue;
        }
        expect(typeof (operation as { summary?: unknown }).summary).toBe('string');
        expect((operation as { summary?: string }).summary).not.toBe('');
        expect(path).toEqual(expect.any(String));
      }
    }
  });
});
