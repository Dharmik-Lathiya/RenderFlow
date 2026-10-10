import { getDb, disconnectDb } from '@renderflow/db';
import { BullMqPublisher, OutboxRelay, countPending } from '@renderflow/outbox';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * outbox-relay: drains `outbox_events` from Postgres into BullMQ.
 *
 * This is the component that makes the transactional outbox safe. The API never
 * pushes to a queue directly after a DB write - it only inserts an outbox row in
 * the same transaction. If Redis is down, rows simply accumulate and are
 * delivered when it returns, so no event is lost.
 *
 * The loop claims rows with `FOR UPDATE SKIP LOCKED` and stamps `attempts` as it
 * claims them, so two relays can run at once without either publishing the same
 * event twice.
 */

const APP_NAME = 'outbox-relay';

async function main(): Promise<void> {
  const queueConfig = loadQueueConfig();
  const db = getDb();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: 'outbox',
    concurrency: 1,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'relay' },
  });

  const publisher = new BullMqPublisher({
    redisUrl: queueConfig.safeRedisUrl,
    prefix: queueConfig.prefix,
  });

  const relay = new OutboxRelay(db, publisher, {
    batchSize: queueConfig.relayBatchSize,
    pollIntervalMs: queueConfig.relayPollIntervalMs,
    maxAttempts: queueConfig.relayMaxAttempts,
  });

  // Drains run in registration order on SIGTERM: stop claiming, close the queue
  // connections, then close the pool. Closing the pool first would abort an
  // in-flight publish and leave its row marked processed-but-undelivered.
  const controller = new AbortController();
  worker.shutdown.registerDrain('relay-loop', () => {
    relay.stop();
    controller.abort();
  });
  worker.shutdown.registerDrain('publisher', () => publisher.close());
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  const pending = await countPending(db);
  worker.logger.info(
    { app: APP_NAME, pending, prefix: queueConfig.prefix },
    pending > 0 ? 'relay starting with a backlog' : 'relay started',
  );

  await relay.run(controller.signal);
}

// `void` + `.catch` rather than top-level `await`: the package is compiled to
// CommonJS, where top-level await is a syntax error.
void main().catch((error: unknown) => {
  abortOnFatal(APP_NAME, error);
});
