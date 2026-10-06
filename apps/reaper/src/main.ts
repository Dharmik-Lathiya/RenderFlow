import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * reaper: the crash-recovery safety net.
 *
 * Every 60s (leader-locked, single instance) it finds `PROCESSING` jobs whose
 * lease expired, re-enqueues orphaned `PENDING` jobs, reconciles `PUBLISHING`
 * jobs against the platform before retrying, and runs the hourly credit ledger
 * reconciliation.
 *
 * This process is why "kill a worker mid-render" is a recoverable event rather
 * than a stuck job. Phase 0 boots it; the sweeps land in Phase 5 - at which point
 * `main` becomes async.
 */

const APP_NAME = 'reaper';

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: 'reaper',
    concurrency: 1,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  worker.shutdown.registerDrain('reaper-loop', () => {
    worker.logger.info({ app: APP_NAME }, 'reaper loop stopped');
  });

  worker.logger.info(
    { app: APP_NAME, intervalSeconds: Number(process.env.REAPER_INTERVAL_SECONDS ?? 60) },
    'leader lock and sweeps not implemented yet (Phase 5)',
  );
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
