import { QUEUE_NAMES } from '@renderflow/common';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * analytics-worker: pulls platform metrics for published posts.
 *
 * Phase 0 boots the process only. Phase 9 adds the scheduled metrics sync that
 * writes `post_metrics` - at which point `main` becomes async.
 */

const APP_NAME = 'analytics-worker';
const QUEUE = QUEUE_NAMES.ANALYTICS;

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: queueConfig.presets[QUEUE].concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  worker.shutdown.registerDrain('analytics', () => {
    worker.logger.info({ app: APP_NAME }, 'analytics scheduler stopped');
  });

  worker.logger.info({ app: APP_NAME }, 'no job handlers registered yet (Phase 9)');
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
