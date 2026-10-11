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
 * content-worker: LLM generation (content plan, captions, hashtags, scripts).
 *
 * Takes the first half of a job. It runs PLAN and SCRIPT and then stops; each
 * stage writes a `job.stage_completed` outbox row, which the relay routes to
 * whichever queue owns the next stage - so a reel genuinely crosses to
 * media-worker without either app knowing the other exists.
 *
 * `handleGenerationJob` refunds on a `PERMANENT` failure or on the final
 * attempt, and rethrows either way so BullMQ owns the retry. A reservation whose
 * worker is killed mid-flight is not handled here: that is the reaper's job.
 *
 * `AI_PROVIDER=mock` in every environment that is not production. Phase 6 wires
 * the real providers behind the same interfaces, and nothing here changes.
 */

const APP_NAME = 'content-worker';
const QUEUE = QUEUE_NAMES.CONTENT;
/** PLAN and SCRIPT only. IMAGE/VOICE/RENDER belong to media-worker. */
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
  });

  const handle = createGenerationProcessor({
    db,
    providers,
    storage,
    stages: OWNED_STAGES,
    // Without a lease, a killed worker leaves a PROCESSING job that nothing can
    // ever reclaim, and a reservation pinned to the user's balance for good.
    lease: { workerId: WORKER_ID, config: loadLease() },
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
    {
      app: APP_NAME,
      stages: OWNED_STAGES,
      attempts: preset.attempts,
      backoff: preset.backoff,
      // Logged because it changes what a reel costs and whether the suite means
      // anything: a worker running mocks in production produces placeholder media
      // and nobody would notice from the logs otherwise.
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
