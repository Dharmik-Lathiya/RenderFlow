import { QUEUE_NAMES } from '@renderflow/common';
import { disconnectDb, getDbHandle, tryAcquireAdvisoryLock } from '@renderflow/db';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { createWorker, loadQueueConfig } from '@renderflow/queue';
import {
  MockMetricsAdapter,
  MetricsSyncProcessor,
  createTokenCipher,
  keyFromEnv,
  metricsAdapterFor,
  type MetricsAdapter,
  type SocialPlatform,
} from '@renderflow/social';

/**
 * analytics-worker: pulls platform metrics for published posts.
 *
 * The database is the schedule. Every `ANALYTICS_POLL_MS` this process asks
 * `publish_jobs` which published posts have no recent snapshot, fetches those,
 * and upserts one row per post per hour. The `analytics` queue is a wake-up that
 * makes a freshly published post appear sooner; losing a message costs latency,
 * not numbers, because the poll does not depend on it.
 *
 * Leader lock
 * -----------
 * The sync makes an external API call per post, so duplicate replicas would
 * double the request rate for no extra data. A Postgres advisory lock elects one
 * worker; the others stand by rather than exiting, so a restart of the leader is
 * covered by an already-running spare.
 *
 * Provider selection
 * ------------------
 * Mock by default, like every other external integration (AGENTS.md section 8).
 * `SOCIAL_PROVIDER=real` selects the Graph API for Instagram; LinkedIn reports
 * "unsupported" rather than inventing numbers, because the share-statistics
 * endpoint needs the organization and share URNs the publisher does not record.
 */

const APP_NAME = 'analytics-worker';
const QUEUE = QUEUE_NAMES.ANALYTICS;
/** "anmt" - fixed, because both sides of an advisory lock must agree. */
const LEADER_LOCK_ID = 0x616e_6d74;

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

function buildAdapter(platform: SocialPlatform): MetricsAdapter {
  if ((process.env.SOCIAL_PROVIDER ?? 'mock') === 'mock') {
    return new MockMetricsAdapter({ platform });
  }

  return metricsAdapterFor(platform, { mock: false });
}

async function main(): Promise<void> {
  // Before connecting to anything: an analytics worker that cannot decrypt
  // account tokens would fail every sync for a reason that looks like a platform
  // outage. Refusing to start is the honest failure.
  const key = keyFromEnv(process.env);
  const cipher = createTokenCipher(key);

  const queueConfig = loadQueueConfig();
  const { db, pool } = getDbHandle();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: queueConfig.presets[QUEUE].concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'metrics' },
  });

  const processor = new MetricsSyncProcessor({
    db,
    decrypt: (ciphertext) => cipher.decrypt(ciphertext),
    adapterFor: buildAdapter,
    firstSyncAfterMs: positiveInt(
      process.env.ANALYTICS_FIRST_SYNC_MS,
      'ANALYTICS_FIRST_SYNC_MS',
      5 * 60_000,
    ),
    refreshAfterMs: positiveInt(
      process.env.ANALYTICS_REFRESH_MS,
      'ANALYTICS_REFRESH_MS',
      6 * 60 * 60_000,
    ),
    limit: positiveInt(process.env.ANALYTICS_BATCH_SIZE, 'ANALYTICS_BATCH_SIZE', 25),
  });

  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  // Registered before the lock: a SIGTERM while connecting must not leave a lock
  // held by a process that has already stopped doing work.
  const controller = new AbortController();
  worker.shutdown.registerDrain('analytics-loop', () => controller.abort());

  const leader = await tryAcquireAdvisoryLock(pool, LEADER_LOCK_ID);

  if (!leader.acquired) {
    worker.logger.info(
      { app: APP_NAME, advisoryLock: LEADER_LOCK_ID },
      'another analytics worker holds the lock; standing by',
    );
    await leader.release();
    await disconnectDb();
    return;
  }

  worker.shutdown.registerDrain('advisory-lock', () => leader.release());

  /**
   * One pass at a time.
   *
   * The poll and a queue wake-up can fire together. Two concurrent passes are
   * harmless for correctness (the upsert is idempotent) but both would call the
   * platform, and the second would write the same numbers. A boolean is enough:
   * extra wake-ups during a pass are coalesced into the next tick.
   */
  let running = false;

  const sync = async (trigger: 'poll' | 'queue'): Promise<void> => {
    if (running || controller.signal.aborted) {
      return;
    }

    running = true;

    try {
      const outcomes = await processor.runOnce();
      const synced = outcomes.filter((outcome) => outcome.status === 'SYNCED').length;
      const failed = outcomes.filter((outcome) => outcome.status === 'FAILED');
      const skipped = outcomes.filter((outcome) => outcome.status === 'SKIPPED').length;

      worker.logger[outcomes.length === 0 ? 'debug' : 'info'](
        { app: APP_NAME, trigger, synced, failed: failed.length, skipped },
        'metrics sync pass complete',
      );

      for (const outcome of failed) {
        worker.logger.warn(
          {
            app: APP_NAME,
            publishJobId: outcome.publishJobId,
            platform: outcome.platform,
            reason: outcome.reason,
          },
          'metrics sync failed; will retry on the next pass',
        );
      }
    } catch (error) {
      worker.logger.error({ app: APP_NAME, trigger, err: error }, 'metrics sync pass failed');
    } finally {
      running = false;
    }
  };

  // The queue entry is an optimisation: it makes a post published a minute ago
  // appear on the dashboard without waiting for the poll.
  const consumer = createWorker<unknown>(QUEUE, queueConfig.presets[QUEUE], {
    factory: { redisUrl: queueConfig.redisUrl, prefix: queueConfig.prefix },
    processor: () => sync('queue'),
  });

  consumer.on('failed', (job, error) => {
    worker.logger.error({ app: APP_NAME, jobId: job?.id, err: error }, 'analytics wake-up failed');
  });

  const pollMs = positiveInt(process.env.ANALYTICS_POLL_MS, 'ANALYTICS_POLL_MS', 60_000);
  const timer = setInterval(() => {
    void sync('poll');
  }, pollMs);
  // Never the reason a process refuses to exit.
  timer.unref();

  worker.shutdown.registerDrain('bullmq', () => consumer.close());
  worker.shutdown.registerDrain('poll-timer', () => clearInterval(timer));

  worker.logger.info(
    {
      app: APP_NAME,
      pollMs,
      provider: process.env.SOCIAL_PROVIDER ?? 'mock',
      advisoryLock: LEADER_LOCK_ID,
    },
    'analytics worker ready',
  );

  // A first pass immediately, so a restart catches up without waiting a minute.
  await sync('poll');
}

void main().catch((error: unknown) => {
  abortOnFatal(APP_NAME, error);
});
