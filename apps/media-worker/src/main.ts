import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from '@renderflow/ai';
import { QUEUE_NAMES, stagesForQueue } from '@renderflow/common';
import { disconnectDb, getDb } from '@renderflow/db';
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
/** This process's lease identity: stable for its lifetime, unique across them. */
const WORKER_ID = workerIdForProcess();

/**
 * Lease configuration, read once at boot.
 *
 * Validated rather than trusted: a heartbeat interval at or above the lease
 * length lets a lease expire while its holder is still running, the reaper
 * hands a live job to a second worker, and both race to capture the credits.
 * That is not a slow-environment problem, so it fails at boot instead.
 */
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
    // Without this a killed worker leaves a PROCESSING job nothing can reclaim.
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
