import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * outbox-relay: drains `outbox_events` from Postgres into BullMQ.
 *
 * This is the component that makes the transactional outbox safe: the API never
 * pushes to a queue directly after a DB write, it only inserts an outbox row in
 * the same transaction. If Redis is down, rows simply accumulate and are
 * delivered when it returns, so no event is lost.
 *
 * Phase 0 boots the process. The `FOR UPDATE SKIP LOCKED` polling loop and the
 * `processed_at` bookkeeping land in Phase 4, when `outbox_events` exists - at
 * which point `main` becomes async.
 */

const APP_NAME = 'outbox-relay';

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: 'outbox',
    concurrency: 1,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  worker.shutdown.registerDrain('relay-loop', () => {
    worker.logger.info({ app: APP_NAME }, 'relay polling loop stopped');
  });

  worker.logger.info(
    { app: APP_NAME, prefix: queueConfig.prefix },
    'outbox table not created yet (Phase 4); relay loop not started',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
