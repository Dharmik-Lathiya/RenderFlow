import { disconnectDb, getDbHandle, tryAcquireAdvisoryLock } from '@renderflow/db';
import { DEFAULT_REAPER, Reaper, type ReaperConfig } from '@renderflow/jobs';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';
import { sweepStalePublishJobs } from '@renderflow/social';

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

    // Publish jobs are swept here rather than in the worker: recovery belongs
    // with the other recovery, and a publisher that is simply down should not
    // depend on that same publisher coming back to notice.
    void sweepStalePublishJobs(db)
      .then((reclaimed) => {
        if (reclaimed > 0) {
          worker.logger.warn(
            { app: APP_NAME, reclaimed },
            'publish jobs reclaimed from a dead publisher',
          );
        }
      })
      .catch((error: unknown) => {
        worker.logger.error({ app: APP_NAME, err: error }, 'publish sweep failed');
      });

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

  // Registered BEFORE the lock loop starts, so a SIGTERM that arrives while we
  // are still connecting does not leave a lock held by a process that has stopped.
  const controller = new AbortController();
  worker.shutdown.registerDrain('reaper-loop', () => {
    controller.abort();
  });

  // Hot-spare loop: instead of exiting when another reaper holds the lock, this
  // process polls every 30 s. If the leader crashes and its session ends, the
  // next tryAcquireAdvisoryLock call here wins the lock without needing an
  // orchestrator restart. SIGTERM (via AbortController) still exits cleanly.
  while (!controller.signal.aborted) {
    const leader = await tryAcquireAdvisoryLock(pool, LEADER_LOCK_ID);

    if (!leader.acquired) {
      worker.logger.info(
        { app: APP_NAME, advisoryLock: LEADER_LOCK_ID },
        'advisory lock not acquired, retrying in 30s',
      );
      await leader.release();

      // Wait 30 s or until SIGTERM aborts the signal, whichever comes first.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      continue;
    }

    // We hold the lock. Register its release and run the sweep loop.
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

    // reaper.run() only resolves when the signal is aborted (SIGTERM). Break out
    // so we do not re-enter the loop and re-acquire the lock.
    break;
  }
}

void main().catch((error: unknown) => {
  abortOnFatal(APP_NAME, error);
});
