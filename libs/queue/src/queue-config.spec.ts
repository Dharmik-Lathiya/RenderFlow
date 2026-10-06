import { QUEUE_NAMES } from '@renderflow/common';

import { QueueConfigError, loadQueueConfig } from './queue-config';
import { RETRY_PRESETS } from './retry-presets';

const BASE_ENV: NodeJS.ProcessEnv = { REDIS_URL: 'redis://localhost:6379' };

describe('loadQueueConfig', () => {
  it('defaults to the documented presets', () => {
    const config = loadQueueConfig(BASE_ENV);
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.prefix).toBe('renderflow');
    expect(config.presets[QUEUE_NAMES.MEDIA]).toEqual(RETRY_PRESETS[QUEUE_NAMES.MEDIA]);
  });

  it('falls back to localhost when REDIS_URL is absent or blank', () => {
    expect(loadQueueConfig({}).redisUrl).toBe('redis://localhost:6379');
    expect(loadQueueConfig({ REDIS_URL: '   ' }).redisUrl).toBe('redis://localhost:6379');
  });

  it('exposes a credential-free url for logging', () => {
    const config = loadQueueConfig({ REDIS_URL: 'redis://user:hunter2@cache:6379/2' });
    expect(config.redisUrl).toBe('redis://user:hunter2@cache:6379/2');
    expect(config.safeRedisUrl).not.toContain('hunter2');
    expect(config.safeRedisUrl).toContain('cache:6379');
  });

  it('honours QUEUE_PREFIX so environments can share a Redis', () => {
    expect(loadQueueConfig({ ...BASE_ENV, QUEUE_PREFIX: 'staging' }).prefix).toBe('staging');
  });

  it('applies per-queue env overrides', () => {
    const config = loadQueueConfig({
      ...BASE_ENV,
      QUEUE_MEDIA_ATTEMPTS: '1',
      QUEUE_MEDIA_BACKOFF_MS: '200',
    });
    expect(config.presets[QUEUE_NAMES.MEDIA]).toEqual({
      attempts: 1,
      concurrency: 2,
      backoff: { type: 'exponential', delay: 200 },
    });
  });

  it('overrides the backoff strategy as well as the delay', () => {
    const config = loadQueueConfig({ ...BASE_ENV, QUEUE_ANALYTICS_BACKOFF_TYPE: 'exponential' });
    expect(config.presets[QUEUE_NAMES.ANALYTICS].backoff.type).toBe('exponential');
    expect(config.presets[QUEUE_NAMES.ANALYTICS].backoff.delay).toBe(60_000);
  });

  it('allows a zero delay (used to make failure tests fast)', () => {
    const config = loadQueueConfig({ ...BASE_ENV, QUEUE_CONTENT_BACKOFF_MS: '0' });
    expect(config.presets[QUEUE_NAMES.CONTENT].backoff.delay).toBe(0);
  });

  it('leaves untouched queues on their defaults', () => {
    const config = loadQueueConfig({ ...BASE_ENV, QUEUE_PUBLISH_ATTEMPTS: '2' });
    expect(config.presets[QUEUE_NAMES.PUBLISH].attempts).toBe(2);
    expect(config.presets[QUEUE_NAMES.CONTENT].attempts).toBe(3);
  });

  it('rejects a non-positive attempt count instead of silently ignoring it', () => {
    expect(() => loadQueueConfig({ ...BASE_ENV, QUEUE_CONTENT_ATTEMPTS: '0' })).toThrow(
      QueueConfigError,
    );
    expect(() => loadQueueConfig({ ...BASE_ENV, QUEUE_CONTENT_ATTEMPTS: 'many' })).toThrow(
      /positive integer/,
    );
  });

  it('rejects a negative backoff delay', () => {
    expect(() => loadQueueConfig({ ...BASE_ENV, QUEUE_MEDIA_BACKOFF_MS: '-5' })).toThrow(
      /non-negative integer/,
    );
  });

  it('rejects an unknown backoff strategy', () => {
    expect(() => loadQueueConfig({ ...BASE_ENV, QUEUE_CONTENT_BACKOFF_TYPE: 'linear' })).toThrow(
      /must be one of exponential, fixed/,
    );
  });

  it('rejects an unusable REDIS_URL', () => {
    expect(() => loadQueueConfig({ REDIS_URL: 'localhost:6379' })).toThrow(QueueConfigError);
    expect(() => loadQueueConfig({ REDIS_URL: 'http://localhost:6379' })).toThrow(
      /redis:\/\/ or rediss:\/\//,
    );
  });

  it('accepts rediss:// for TLS Redis', () => {
    expect(loadQueueConfig({ REDIS_URL: 'rediss://cache:6380' }).redisUrl).toBe(
      'rediss://cache:6380',
    );
  });
});
