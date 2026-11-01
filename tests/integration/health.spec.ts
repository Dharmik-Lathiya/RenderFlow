import { createTestApp, type TestApp } from './helpers/app-harness';
import { HealthService } from '../../apps/api/src/health/health.service';

/**
 * Readiness and liveness at the HTTP layer.
 *
 * The unit suite asserts the probe machinery; this suite asserts the contract an
 * orchestrator actually consumes: unversioned routes, a 200/503 status, and the
 * same report body in both cases. Probes are replaced with deterministic
 * doubles so the test does not depend on whether MinIO happens to be running -
 * CI has PostgreSQL and Redis but no object store.
 */
describe('health endpoints', () => {
  let app: TestApp;
  let health: HealthService;

  beforeAll(async () => {
    app = await createTestApp();
    health = app.app.get(HealthService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness without touching a dependency', async () => {
    const res = await app.http().get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      service: 'api',
      uptimeSeconds: expect.any(Number),
    });
  });

  it('returns 200 when every dependency is up', async () => {
    const up = async (): Promise<boolean> => true;
    health.registerProbe('db', up);
    health.registerProbe('redis', up);
    health.registerProbe('s3', up);

    const res = await app.http().get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up', s3: 'up' },
    });
  });

  it('returns 503 with the report when one dependency is down', async () => {
    const up = async (): Promise<boolean> => true;
    const down = async (): Promise<boolean> => false;
    health.registerProbe('db', up);
    health.registerProbe('redis', up);
    health.registerProbe('s3', down);

    const res = await app.http().get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'degraded',
      checks: { db: 'up', redis: 'up', s3: 'down' },
    });
  });
});
