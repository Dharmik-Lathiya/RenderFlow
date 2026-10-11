import { QUEUE_NAMES, stagesForQueue, type JobStage } from '@renderflow/common';
import { disconnectDb, getDb } from '@renderflow/db';
import { createProviders } from '@renderflow/ai';
import {
  createGenerationProcessor,
  describeError,
  workerIdForProcess,
  validateLeaseConfig,
  type LeaseConfig,
} from '@renderflow/jobs';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { createWorker, loadQueueConfig } from '@renderflow/queue';
import { S3Storage, loadStorageConfig } from '@renderflow/storage';

/**
 * media-worker: image generation, TTS voiceover and FFmpeg render.
 *
 * Takes the second half of a reel. `stagesForQueue` is the single source of
 * truth for the split - this worker cannot start a stage it does not own, which
 * is what stops a duplicate media stage running in parallel with content-worker if
 * an event is delivered twice.
 *
 * Concurrency is 2, against 5 on content, because rendering is CPU bound: the
 * preset is set in libs/queue and this app only obeys it.
 *
 * FFmpeg children are registered as a drain below so they cannot outlive the
 * worker on SIGTERM. With mock providers there are none yet; the registration has
 * to exist before the first real render does, not after.
 */

const APP_NAME = 'media-worker';
const QUEUE = QUEUE_NAMES.MEDIA;
const OWNED_STAGES = stagesForQueue(QUEUE) as readonly JobStage[];
const WORKER_ID = workerIdForProcess();

function loadLease(): LeaseConfig {
  return validateLeaseConfig({
    leaseSeconds: positiveInt(process.env.JOB_LEASE_SECONDS, 'JOB_LEASE_SECONDS', 120),
    heartbeatSeconds: positiveInt(process.env.HEARTBEAT_SECONDS, 'HEARTBEAT_SECONDS', 30),
    maxAttempts: positiveInt(process.env.MAX_JOB_ATTEMPTS, 'MAX_JOB_ATTEMPTS', 3),
  });
}

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
  const queueConfig = loadQueueConfig();
  const preset = queueConfig.presets[QUEUE];
  const db = getDb();
  const storage = new S3Storage(loadStorageConfig());

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: preset.concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'consume' },
  });

  const providers = createProviders({
    env: process.env,
    sink: {
      put: async (input) => {
        await storage.putObject(input);
      },
    },
    rendererStorage: storage,
    ...(process.env.BRAND_WATERMARK === undefined
      ? {}
      : { watermark: process.env.BRAND_WATERMARK }),
    ...(process.env.BRAND_COLOR === undefined ? {} : { watermarkColor: process.env.BRAND_COLOR }),
  });

  const handle = createGenerationProcessor({
    db,
    providers,
    storage,
    stages: OWNED_STAGES,
    lease: { workerId: WORKER_ID, config: loadLease() },
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

  // Drains in registration order, as in content-worker: stop consuming, let the
  // in-flight render finish, then the connections, then the pool.
  worker.shutdown.registerDrain('bullmq', () => consumer.close());
  // Phase 6 renders through ffmpeg today, synchronously, inside the handler -
  // so by the time this drain runs there is nothing left to kill. Registered now
  // so that the ordering is already decided when a future change makes renders
  // detached rather than retrofitting a reaper under pressure.
  worker.shutdown.registerDrain('ffmpeg', () => {
    worker.logger.info({ app: APP_NAME }, 'ffmpeg renders run in-process; nothing to terminate');
  });
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  worker.logger.info(
    {
      app: APP_NAME,
      stages: OWNED_STAGES,
      attempts: preset.attempts,
      providerMode: providers.allMock ? 'mock' : 'real',
    },
    'worker ready',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
