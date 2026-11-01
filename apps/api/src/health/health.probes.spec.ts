import {
  DB_PROBE_TIMEOUT_MS,
  REDIS_PROBE_TIMEOUT_MS,
  S3_PROBE_TIMEOUT_MS,
  registerDependencyProbes,
} from './health.probes';
import { HealthService } from './health.service';

describe('registerDependencyProbes', () => {
  it('registers the three documented dependency names with their own budgets', () => {
    const health = new HealthService();
    const registered = jest.spyOn(health, 'registerProbe');
    const probes = {
      db: jest.fn(async () => true),
      redis: jest.fn(async () => true),
      s3: jest.fn(async () => true),
    };

    registerDependencyProbes(health, probes);

    expect(registered).toHaveBeenCalledWith('db', probes.db, DB_PROBE_TIMEOUT_MS);
    expect(registered).toHaveBeenCalledWith('redis', probes.redis, REDIS_PROBE_TIMEOUT_MS);
    expect(registered).toHaveBeenCalledWith('s3', probes.s3, S3_PROBE_TIMEOUT_MS);
  });

  it('produces the response keys orchestrators and the API client expect', async () => {
    const health = new HealthService();

    registerDependencyProbes(health, {
      db: async () => true,
      redis: async () => true,
      s3: async () => true,
    });

    await expect(health.checkReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up', s3: 'up' },
    });
  });
});
