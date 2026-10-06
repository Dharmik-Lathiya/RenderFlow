import {
  createGracefulShutdown,
  redactConnectionUrl,
  type GracefulShutdown,
} from '@renderflow/common';

import { createLogger, toShutdownLogger, type Logger } from './logger';

/**
 * Shared worker bootstrap.
 *
 * Six of the eight apps are long-running workers with the same shape: load
 * config, install SIGTERM handling, log what they are, and only then start
 * consuming. Duplicating that across apps/* is how one worker ends up draining
 * differently from the rest, so it lives here - next to the logger, and free of
 * any dependency on libs/queue (the caller passes the resolved preset values).
 */

export interface WorkerProcessOptions {
  /** Process/app name used in log lines and the shutdown context. */
  appName: string;
  /** Queue this worker consumes, for logging and later for metrics labels. */
  queue: string;
  concurrency: number;
  /** Connection URL, shown for troubleshooting. Redacted before it is logged. */
  redisUrl: string;
  /** Extra fields merged into every log line (e.g. { stage: 'bootstrap' }). */
  base?: Record<string, unknown>;
  /** Total budget for SIGTERM drains. */
  drainTimeoutMs?: number;
}

export interface WorkerProcess {
  logger: Logger;
  shutdown: GracefulShutdown;
  startedAt: Date;
}

export function startWorkerProcess(options: WorkerProcessOptions): WorkerProcess {
  const logger = createLogger({
    service: options.appName,
    base: { app: options.appName, ...options.base },
  });

  const shutdown = createGracefulShutdown({
    name: options.appName,
    logger: toShutdownLogger(logger),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  shutdown.install();

  const startedAt = new Date();
  logger.info(
    {
      app: options.appName,
      queue: options.queue,
      concurrency: options.concurrency,
      // Defence in depth: the caller is expected to pass an already-safe value,
      // but a connection URL with an embedded password must never reach a log.
      redis: redactConnectionUrl(options.redisUrl),
      pid: process.pid,
      node: process.version,
    },
    'worker process started',
  );

  return { logger, shutdown, startedAt };
}

/**
 * Last-resort handler for a failure during bootstrap: log it and exit non-zero
 * so the orchestrator restarts the process instead of leaving it half-alive.
 */
export function abortOnFatal(appName: string, error: unknown): never {
  const logger = createLogger({ service: appName });
  logger.error({ app: appName, err: error }, 'worker process failed to start');
  process.exit(1);
}
