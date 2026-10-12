import { QUEUE_NAMES } from '@renderflow/common';
import { disconnectDb, getDb } from '@renderflow/db';
import { workerIdForProcess } from '@renderflow/jobs';
import {
  MockSocialAdapter,
  PlatformRateLimiter,
  PublishProcessor,
  keyFromEnv,
  type SocialPlatform,
} from '@renderflow/social';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { createWorker, loadQueueConfig } from '@renderflow/queue';

import { NotificationsBridge } from './notifications.bridge';

/**
 * publisher-worker: posts approved content to LinkedIn and Instagram on schedule.
 *
 * Two inputs wake it up, and the redundancy is deliberate:
 *
 *  - the `publish` queue, whose delayed entry arrives on time;
 *  - a poll over `publish_jobs`, because a delayed BullMQ message is a message
 *    in Redis and a Redis restart loses it. `publish_jobs.scheduled_for` is the
 *    truth, so the poll is what makes a lost message cost latency rather than
 *    the post.
 *
 * The handler itself is `PublishProcessor` in `libs/social`, not here: the
 * behaviour worth testing - a worker killed mid-publish, a token that expired an
 * hour ago - needs a real database, and that is not reachable from a `main()`.
 *
 * `TOKEN_ENCRYPTION_KEY` is asserted HERE and not lazily, the opposite of the
 * API's choice. This process exists only to publish, so starting without the
 * ability to decrypt means accepting jobs it cannot perform: it would claim
 * them, fail them, burn their retries, and tell the user their account needs
 * reconnecting when nothing is wrong with it. Refusing to start is the honest
 * failure.
 */

const APP_NAME = 'publisher-worker';
const QUEUE = QUEUE_NAMES.PUBLISH;
/** This process's lease identity: stable for its lifetime, unique across them. */
const WORKER_ID = workerIdForProcess();

/**
 * Per-platform publish limits.
 *
 * Every one of these platforms enforces a limit, and exceeding it gets the
 * whole app's tokens throttled rather than just the offending request. These
 * are deliberately conservative placeholders: the real quotas are per app id
 * and were not verifiable from here, so they are configuration rather than
 * constants that look authoritative.
 */
const PLATFORM_LIMITS: Partial<Record<SocialPlatform, { perWindow: number; windowMs: number }>> = {
  linkedin: { perWindow: 30, windowMs: 60_000 },
  instagram: { perWindow: 25, windowMs: 60_000 },
};

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function main(): void {
  // Before anything else, and before a connection is opened: fail loudly and
  // immediately rather than on the first publish of the day.
  keyFromEnv(process.env);

  const queueConfig = loadQueueConfig();
  const preset = queueConfig.presets[QUEUE];
  const db = getDb();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: preset.concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'consume' },
  });

  const limiters = new Map<string, PlatformRateLimiter>();

  const processor = new PublishProcessor({
    db,
    workerId: WORKER_ID,
    notify: new NotificationsBridge(db),
    // Mocks in every environment that is not production (AGENTS.md section 8).
    // Real adapters land behind the same interface; nothing here changes.
    adapterFor: (platform: SocialPlatform) => new MockSocialAdapter({ platform }),
    limiterFor: (platform: SocialPlatform) => {
      const existing = limiters.get(platform);

      if (existing !== undefined) {
        return existing;
      }

      const limit = PLATFORM_LIMITS[platform] ?? { perWindow: 10, windowMs: 60_000 };
      const created = new PlatformRateLimiter(platform, limit.perWindow, limit.windowMs);
      limiters.set(platform, created);
      return created;
    },
    leaseSeconds: positiveInt(process.env.PUBLISH_LEASE_SECONDS, 'PUBLISH_LEASE_SECONDS', 120),
    heartbeatSeconds: positiveInt(
      process.env.PUBLISH_HEARTBEAT_SECONDS,
      'PUBLISH_HEARTBEAT_SECONDS',
      30,
    ),
  });

  // The queue entry is a wake-up, not the work. The processor claims from the
  // database, so a duplicate or delayed delivery is a no-op rather than a
  // second publish.
  const consumer = createWorker<unknown>(QUEUE, preset, {
    factory: { redisUrl: queueConfig.redisUrl, prefix: queueConfig.prefix },
    processor: async () => {
      const outcomes = await processor.runOnce();

      for (const outcome of outcomes) {
        worker.logger.info(
          {
            app: APP_NAME,
            jobId: outcome.jobId,
            status: outcome.status,
            recovered: outcome.recovered,
          },
          'publish finished',
        );
      }
    },
  });

  consumer.on('failed', (job, error) => {
    // The processor catches publish failures itself - a failed publish is a row to
    // update, not an exception. Reaching here means something structural broke.
    worker.logger.error({ app: APP_NAME, jobId: job?.id, err: error }, 'publish wake-up failed');
  });

  // The safety net for a delayed message that Redis lost.
  const pollMs = positiveInt(process.env.PUBLISH_POLL_MS, 'PUBLISH_POLL_MS', 1_000);
  const poll = setInterval(() => {
    void processor.runOnce().catch((error: unknown) => {
      worker.logger.error({ app: APP_NAME, err: error }, 'publish poll failed');
    });
  }, pollMs);
  poll.unref();

  worker.shutdown.registerDrain('bullmq', () => consumer.close());
  worker.shutdown.registerDrain('poll', () => clearInterval(poll));
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  worker.logger.info(
    { app: APP_NAME, pollMs, limits: PLATFORM_LIMITS, providerMode: 'mock' },
    'worker ready',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
