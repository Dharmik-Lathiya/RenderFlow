import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from '@renderflow/ai';
import { QUEUE_NAMES, stagesForQueue, type JobStage } from '@renderflow/common';
import { disconnectDb, getDb } from '@renderflow/db';
import { createGenerationProcessor, describeError } from '@renderflow/jobs';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { createWorker, loadQueueConfig } from '@renderflow/queue';
import { S3Storage, loadStorageConfig } from '@renderflow/storage';

/**
 * content-worker: runs generation jobs.
 *
 * The pipeline itself lives in `@renderflow/jobs`; this process is wiring. That
 * split is deliberate. It is what lets the runner's behaviour - checkpoints,
 * resume, capture, refund - be tested against a real database without a Redis,
 * and it is what stops the retry policy from drifting between six worker apps.
 *
 * It runs PLAN and SCRIPT and then stops. Each stage writes a
 * `job.stage_completed` outbox row, which the relay routes to whichever queue
 * owns the next stage - so a reel genuinely crosses to media-worker rather than
 * one app quietly doing all of it.
 *
 * `handleGenerationJob` refunds on a `PERMANENT` failure or on the final
 * attempt, and rethrows either way so BullMQ owns the retry. A reservation whose
 * worker is killed mid-flight is not handled here: that is Phase 5's reaper.
 *
 * AI_PROVIDER=mock in every environment that is not production. Phase 6 swaps in
 * the real providers behind the same interfaces, and nothing here changes.
 */

const APP_NAME = 'content-worker';
const QUEUE = QUEUE_NAMES.CONTENT;
/** PLAN and SCRIPT only. IMAGE/VOICE/RENDER belong to media-worker. */
const OWNED_STAGES = stagesForQueue(QUEUE) as readonly JobStage[];

function main(): void {
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

  // One options object shared by every provider, so `FAIL_EVERY_NTH` counts
  // across the whole job rather than resetting per provider: "fail the third
  // call" has to mean the third call of the job, not of whichever stage reached
  // it. Tests depend on that being true.
  const mockOptions = mockOptionsFromEnv();

  const handle = createGenerationProcessor({
    db,
    providers: {
      text: new MockTextProvider(mockOptions),
      image: new MockImageProvider(mockOptions),
      tts: new MockTtsProvider(mockOptions),
      renderer: new MockRendererProvider(mockOptions),
    },
    storage: new S3Storage(loadStorageConfig()),
    stages: OWNED_STAGES,
    // Matches the queue preset, so "the last attempt" means the same thing to the
    // handler as it does to BullMQ.
    defaultAttempts: preset.attempts,
  });

  const consumer = createWorker<unknown>(QUEUE, preset, {
    factory: { redisUrl: queueConfig.redisUrl, prefix: queueConfig.prefix },
    processor: async (job) => {
      await handle(job);
      worker.logger.info({ app: APP_NAME, jobId: job.id }, 'generation job processed');
    },
  });

  consumer.on('failed', (job, error) => {
    worker.logger.error(
      {
        app: APP_NAME,
        jobId: job?.id,
        // BullMQ's attempt counter, not ours: this is the number that decides
        // whether the job is dead or waiting for a retry.
        attempt: job?.attemptsMade,
        err: describeError(error),
      },
      'generation job failed',
    );
  });

  // Drains in registration order: stop taking new jobs and let the in-flight one
  // finish, then close connections, then the pool. Closing the pool first would
  // abort the very job the drain exists to protect.
  worker.shutdown.registerDrain('bullmq', () => consumer.close());
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  worker.logger.info(
    { app: APP_NAME, stages: OWNED_STAGES, attempts: preset.attempts, backoff: preset.backoff },
    'worker ready',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
