import { QUEUE_NAMES } from '@renderflow/common';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * content-worker: LLM generation (content plan, captions, hashtags, scripts).
 *
 * Phase 0 boots the process and wires config + graceful shutdown only. Job
 * handlers are registered in Phase 4, together with the lease/heartbeat and
 * checkpoint logic they depend on - at which point `main` becomes async.
 */

const APP_NAME = 'content-worker';
const QUEUE = QUEUE_NAMES.CONTENT;

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: queueConfig.presets[QUEUE].concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  // Registered for anything this worker opens (BullMQ connections, S3 clients).
  // Phase 4 replaces this with the real `worker.close()`.
  worker.shutdown.registerDrain('redis', () => {
    worker.logger.info({ app: APP_NAME }, 'redis connection drained');
  });

  worker.logger.info({ app: APP_NAME }, 'no job handlers registered yet (Phase 4)');
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
