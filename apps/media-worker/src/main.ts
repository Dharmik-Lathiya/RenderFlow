import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from '@renderflow/ai';
import { QUEUE_NAMES, stagesForQueue } from '@renderflow/common';
import { disconnectDb, getDb } from '@renderflow/db';
import { createGenerationProcessor, describeError } from '@renderflow/jobs';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { createWorker, loadQueueConfig } from '@renderflow/queue';
import { S3Storage, loadStorageConfig } from '@renderflow/storage';
import type { JobStage } from '@renderflow/common';

/**
 * media-worker: image generation, TTS voiceover and FFmpeg render.
 *
 * Takes the second half of a reel. `stagesForQueue` is the single source of
 * truth for the split - this worker cannot start a stage it does not own, which
 * is what stops a duplicate media stage running in parallel with content-worker
 * if an event is delivered twice.
 *
 * Concurrency is 2, against 5 on content, because rendering is CPU bound: the
 * preset is set in libs/queue and this app only obeys it.
 *
 * FFmpeg children are registered as a drain below so they cannot outlive the
 * worker on SIGTERM. With mock providers there are none yet; the registration
 * has to exist before the first real render does, not after.
 */

const APP_NAME = 'media-worker';
const QUEUE = QUEUE_NAMES.MEDIA;
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

  const mockOptions = mockOptionsFromEnv();

  const handle = createGenerationProcessor({
    db,
    providers: {
      // The media worker never runs PLAN or SCRIPT, but the runner takes the
      // whole set, so the interfaces are all supplied.
      text: new MockTextProvider(mockOptions),
      image: new MockImageProvider(mockOptions),
      tts: new MockTtsProvider(mockOptions),
      renderer: new MockRendererProvider(mockOptions),
    },
    storage: new S3Storage(loadStorageConfig()),
    stages: OWNED_STAGES,
    defaultAttempts: preset.attempts,
  });

  const consumer = createWorker<unknown>(QUEUE, preset, {
    factory: { redisUrl: queueConfig.redisUrl, prefix: queueConfig.prefix },
    processor: async (job) => {
      await handle(job);
      worker.logger.info({ app: APP_NAME, jobId: job.id }, 'media job processed');
    },
  });

  consumer.on('failed', (job, error) => {
    worker.logger.error(
      { app: APP_NAME, jobId: job?.id, attempt: job?.attemptsMade, err: describeError(error) },
      'media job failed',
    );
  });

  worker.shutdown.registerDrain('bullmq', () => consumer.close());
  // Phase 6 adds the real child-process reaper here; registered now so the
  // ordering is already decided rather than being retrofitted under pressure.
  worker.shutdown.registerDrain('ffmpeg', () => {
    worker.logger.info({ app: APP_NAME }, 'no ffmpeg children to terminate');
  });
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  worker.logger.info(
    { app: APP_NAME, stages: OWNED_STAGES, attempts: preset.attempts },
    'worker ready',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
