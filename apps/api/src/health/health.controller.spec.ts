import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * The controller is where readiness becomes an HTTP contract. A report of
 * `degraded` that still answers 200 is what leaves a dead instance in a load
 * balancer's rotation, so the status code is asserted separately from the body.
 */
describe('HealthController', () => {
  let app: INestApplication;
  let health: HealthService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    health = app.get(HealthService);
  });

  afterEach(async () => {
    await app.close();
  });

  function registerAll(state: 'up' | 'down'): void {
    const probe = async (): Promise<boolean> => state === 'up';
    health.registerProbe('db', probe);
    health.registerProbe('redis', probe);
    health.registerProbe('s3', probe);
  }

  it('returns 200 with every check up when all dependencies answer', async () => {
    registerAll('up');

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up', s3: 'up' },
    });
  });

  it('returns 503 and preserves the report when any dependency is down', async () => {
    registerAll('up');
    health.registerProbe('db', async () => false);

    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toEqual({
      status: 'degraded',
      checks: { db: 'down', redis: 'up', s3: 'up' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps liveness independent of the dependencies', async () => {
    const probe = jest.fn(async () => false);
    health.registerProbe('db', probe);

    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', service: 'api' });
    expect(probe).not.toHaveBeenCalled();
  });
});
