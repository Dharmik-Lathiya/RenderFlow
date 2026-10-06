import { Queue, Worker, type Job, type JobsOptions, type Processor } from 'bullmq';

import type { QueueName } from '@renderflow/common';

import { toConnectionOptions, type RedisConnectionOptions } from './redis-connection';
import { toWorkerOptions, type RetryPreset } from './retry-presets';

/**
 * BullMQ factories. Every queue and worker in RenderFlow is created here so that
 * connection semantics, job ids and retry options cannot drift between the six
 * worker apps.
 */

export interface FactoryOptions {
  redisUrl: string;
  /** Defaults to `renderflow`; set QUEUE_PREFIX to share one Redis per environment. */
  prefix?: string;
}

const DEFAULT_PREFIX = 'renderflow';

/**
 * Job ids are deterministic (`generation:<jobId>`, `publish:<publishJobId>`).
 * BullMQ drops a duplicate add, which is a second line of defence behind the
 * outbox for the "relay retried" case.
 */
export function deterministicJobId(prefix: string, aggregateId: string): string {
  return `${prefix}:${aggregateId}`;
}

/** Retry/backoff options for a job enqueued on `preset`'s queue. */
export function defaultJobOptions(preset: RetryPreset): JobsOptions {
  return {
    attempts: preset.attempts,
    backoff: { ...preset.backoff },
    // Keep finished jobs out of Redis long enough for the reaper and DLQ tooling
    // to observe them, without unbounded growth.
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: false,
  };
}

export function createQueue(name: QueueName, preset: RetryPreset, options: FactoryOptions): Queue {
  return new Queue(name, {
    connection: toConnectionOptions({ url: options.redisUrl, maxRetriesPerRequest: null }),
    prefix: options.prefix ?? DEFAULT_PREFIX,
    defaultJobOptions: defaultJobOptions(preset),
  });
}

export interface WorkerDeps<T = unknown> {
  factory: FactoryOptions;
  processor: Processor<T>;
}

export function createWorker<T = unknown>(
  name: QueueName,
  preset: RetryPreset,
  deps: WorkerDeps<T>,
): Worker<T> {
  return new Worker<T>(name, deps.processor, {
    ...toWorkerOptions(preset),
    connection: toConnectionOptions({ url: deps.factory.redisUrl, maxRetriesPerRequest: 0 }),
    prefix: deps.factory.prefix ?? DEFAULT_PREFIX,
  });
}

/** Exposed for apps that need the raw shape (health checks, tests). */
export function connectionOptionsFor(options: FactoryOptions): RedisConnectionOptions {
  return toConnectionOptions({ url: options.redisUrl, maxRetriesPerRequest: null });
}

/** Narrowing helper so handlers can trust the payload type after validation. */
export function jobData<T>(job: Job): T {
  return job.data as T;
}
