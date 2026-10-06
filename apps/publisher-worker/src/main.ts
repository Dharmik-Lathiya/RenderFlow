import { QUEUE_NAMES } from '@renderflow/common';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * publisher-worker: posts approved content to Instagram/LinkedIn on schedule.
 *
 * Phase 0 boots the process only. Phase 7 adds the idempotent publish handler
 * (check `external_post_id` before posting), token refresh, and the
 * per-platform rate limiter - at which point `main` becomes async.
 */

const APP_NAME = 'publisher-worker';
const QUEUE = QUEUE_NAMES.PUBLISH;

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: queueConfig.presets[QUEUE].concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  worker.shutdown.registerDrain('publish-inflight', () => {
    worker.logger.info({ app: APP_NAME }, 'in-flight publishes released');
  });

  worker.logger.info({ app: APP_NAME }, 'no job handlers registered yet (Phase 7)');
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
