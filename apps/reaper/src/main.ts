import { disconnectDb, getDbHandle, tryAcquireAdvisoryLock } from '@renderflow/db';
import { DEFAULT_REAPER, Reaper, type ReaperConfig } from '@renderflow/jobs';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * reaper: the crash-recovery safety net.
 *
 * Every 60s it finds `PROCESSING` jobs whose lease expired, re-enqueues
 * orphaned `PENDING` jobs, and reports the events the relay gave up on.
 *
 * This process is why "kill a worker mid-render" is a recoverable event rather
 * than a stuck job with a reservation pinned to a user's balance.
 *
 * Leader lock
 * -----------
 * The spec says "leader-locked, single instance". A Postgres advisory lock gives
 * that for free and needs no Redis: the first reaper to start holds it, and the
 * others wait rather than running duplicate sweeps. Two reapers are not harmful -
 * every sweep is a guarded UPDATE, so they would agree - but they would double
 * the queries for nothing, and "which one is doing the work" is a question an
 * operator should be able to answer.
 */

const APP_NAME = 'reaper';
/** Arbitrary but fixed: an advisory lock is a bigint, and both sides must agree. */
const LEADER_LOCK_ID = 0x7265_7065; // "repe"

function readPositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    // Fail at boot. A reaper running with a nonsense lease or interval is worse
    // than one that does not run: it looks like coverage and is not.
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function loadReaperConfig(queueOutboxMaxAttempts: number): ReaperConfig {
  return {
    leaseSeconds: readPositiveInt(
      process.env.JOB_LEASE_SECONDS,
      'JOB_LEASE_SECONDS',
      DEFAULT_REAPER.leaseSeconds,
    ),
    heartbeatSeconds: readPositiveInt(
      process.env.HEARTBEAT_SECONDS,
      'HEARTBEAT_SECONDS',
      DEFAULT_REAPER.heartbeatSeconds,
    ),
    maxAttempts: readPositiveInt(
      process.env.MAX_JOB_ATTEMPTS,
      'MAX_JOB_ATTEMPTS',
      DEFAULT_REAPER.maxAttempts,
    ),
    intervalSeconds: readPositiveInt(
      process.env.REAPER_INTERVAL_SECONDS,
      'REAPER_INTERVAL_SECONDS',
      DEFAULT_REAPER.intervalSeconds,
    ),
    orphanAfterSeconds: readPositiveInt(
      process.env.REAPER_ORPHAN_AFTER_SECONDS,
      'REAPER_ORPHAN_AFTER_SECONDS',
      DEFAULT_REAPER.orphanAfterSeconds,
    ),
    outboxMaxAttempts: queueOutboxMaxAttempts,
    batchSize: DEFAULT_REAPER.batchSize,
  };
}

async function main(): Promise<void> {
  const queueConfig = loadQueueConfig();
  const { db, pool } = getDbHandle();
  const config = loadReaperConfig(queueConfig.relayMaxAttempts);

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: 'reaper',
    concurrency: 1,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'sweep' },
  });

  // The controller owns the sweep loop, not the shutdown registry: the reaper
  // never opens a connection of its own, so there is nothing to drain but the
  // loop and the pool.
  worker.shutdown.registerDrain('postgres', () => disconnectDb());

  const reaper = new Reaper(db, config, (report) => {
    worker.logger[report.requeued.length > 0 || report.failed.length > 0 ? 'warn' : 'debug'](
      {
        app: APP_NAME,
        examined: report.examined,
        requeued: report.requeued.length,
        failed: report.failed.length,
        abandonedOutbox: report.abandonedOutbox.length,
      },
      'reaper sweep complete',
    );

    if (report.failed.length > 0) {
      // Refunds are the expensive outcome, so they are logged by id: an operator
      // reconciling a balance needs to find the job that took the credits back.
      worker.logger.warn({ app: APP_NAME, jobs: report.failed }, 'jobs given up on and refunded');
    }

    if (report.abandonedOutbox.length > 0) {
      worker.logger.error(
        {
          app: APP_NAME,
          events: report.abandonedOutbox.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            aggregateId: e.aggregateId,
            attempts: e.attempts,
          })),
        },
        'outbox events the relay abandoned - replay via the admin API',
      );
    }
  });

  // Registered BEFORE the lock is taken, so a SIGTERM that arrives while we are
  // still connecting does not leave a lock held by a process that has stopped.
  const controller = new AbortController();
  worker.shutdown.registerDrain('reaper-loop', () => {
    controller.abort();
  });

  const leader = await tryAcquireAdvisoryLock(pool, LEADER_LOCK_ID);

  if (!leader.acquired) {
    // Not an error. A second reaper is a spare, not a fault, and exiting
    // non-zero would have an orchestrator restart it in a loop that loses the
    // race every time.
    worker.logger.info(
      { app: APP_NAME, advisoryLock: LEADER_LOCK_ID },
      'another reaper holds the lock; standing by',
    );
    await leader.release();
    await disconnectDb();
    return;
  }

  worker.shutdown.registerDrain('advisory-lock', () => leader.release());

  worker.logger.info(
    {
      app: APP_NAME,
      intervalSeconds: config.intervalSeconds,
      leaseSeconds: config.leaseSeconds,
      maxAttempts: config.maxAttempts,
      advisoryLock: LEADER_LOCK_ID,
    },
    'reaper started',
  );

  await reaper.run(controller.signal);
}

void main().catch((error: unknown) => {
  abortOnFatal(APP_NAME, error);
});
