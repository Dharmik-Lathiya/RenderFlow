import { ALL_QUEUE_NAMES, type QueueName } from '@renderflow/common';

import { redactConnectionUrl } from '@renderflow/common';

import {
  RETRY_PRESETS,
  resolveRetryPresets,
  type BackoffType,
  type RetryPreset,
} from './retry-presets';

/**
 * The one place in the queue lib that reads the environment.
 *
 * AGENTS.md rule: "Never read `process.env` directly outside the config module."
 * Apps call `loadQueueConfig(process.env)` once at the edge of `main.ts` and pass
 * the resulting frozen config down, so nothing below the entry point touches env.
 *
 * Override scheme, one variable per knob:
 *   QUEUE_CONTENT_ATTEMPTS=1            faster retry in tests
 *   QUEUE_MEDIA_BACKOFF_MS=200
 *   QUEUE_PUBLISH_BACKOFF_TYPE=fixed
 */

export interface QueueConfig {
  /** Use for connecting. May contain credentials - never log this. */
  redisUrl: string;
  /** Credential-free form, safe for logs and health output. */
  safeRedisUrl: string;
  presets: Readonly<Record<QueueName, RetryPreset>>;
  /** BullMQ prefix, so several environments can share one Redis. */
  prefix: string;
  /**
   * Outbox relay tuning.
   *
   * These live here rather than in `libs/outbox` because they are deployment
   * knobs in the same family as the retry presets, and AGENTS.md is explicit
   * that retry counts and timeouts are configuration rather than literals
   * scattered through the code that uses them.
   */
  relayBatchSize: number;
  relayPollIntervalMs: number;
  relayMaxAttempts: number;
}

export class QueueConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueConfigError';
  }
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_PREFIX = 'renderflow';

/**
 * Relay defaults.
 *
 * Batch 50 and poll 1s: a generation takes seconds to minutes, so an extra
 * second of latency is invisible to the user, while an unbounded batch would
 * hold a database connection and a lock for as long as it took to drain.
 */
export const DEFAULT_RELAY_BATCH_SIZE = 50;
export const DEFAULT_RELAY_POLL_INTERVAL_MS = 1_000;
/**
 * Ten failed publishes before an event is abandoned.
 *
 * Each retry is a backoff away, so this is roughly a minute of a queue being
 * down. Longer and a transient outage costs users a generation; shorter and a
 * single bad payload looks like an outage.
 */
export const DEFAULT_RELAY_MAX_ATTEMPTS = 10;

const BACKOFF_TYPES: readonly BackoffType[] = ['exponential', 'fixed'];

function envName(queue: QueueName, knob: string): string {
  return `QUEUE_${queue.toUpperCase()}_${knob}`;
}

function readPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new QueueConfigError(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function readNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new QueueConfigError(`${name} must be a non-negative integer, received "${raw}"`);
  }
  return value;
}

function readBackoffType(raw: string | undefined, name: string): BackoffType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (!BACKOFF_TYPES.includes(raw as BackoffType)) {
    throw new QueueConfigError(
      `${name} must be one of ${BACKOFF_TYPES.join(', ')}, received "${raw}"`,
    );
  }
  return raw as BackoffType;
}

export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const redisUrl = env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;

  try {
    // Validate before we trust it: a typo here fails at boot, not mid-job.
    const parsed = new URL(redisUrl);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new QueueConfigError(
        `REDIS_URL must use redis:// or rediss://, received "${redisUrl}"`,
      );
    }
  } catch (error) {
    if (error instanceof QueueConfigError) {
      throw error;
    }
    throw new QueueConfigError(`REDIS_URL is not a valid URL: "${redisUrl}"`);
  }

  const overrides: Partial<Record<QueueName, Partial<RetryPreset>>> = {};

  for (const queue of ALL_QUEUE_NAMES) {
    const attempts = readPositiveInt(env[envName(queue, 'ATTEMPTS')], envName(queue, 'ATTEMPTS'));
    const concurrency = readPositiveInt(
      env[envName(queue, 'CONCURRENCY')],
      envName(queue, 'CONCURRENCY'),
    );
    const delay = readNonNegativeInt(
      env[envName(queue, 'BACKOFF_MS')],
      envName(queue, 'BACKOFF_MS'),
    );
    const backoffType = readBackoffType(
      env[envName(queue, 'BACKOFF_TYPE')],
      envName(queue, 'BACKOFF_TYPE'),
    );

    if (
      attempts === undefined &&
      concurrency === undefined &&
      delay === undefined &&
      backoffType === undefined
    ) {
      continue;
    }

    const base = RETRY_PRESETS[queue];
    overrides[queue] = {
      ...(attempts === undefined ? {} : { attempts }),
      ...(concurrency === undefined ? {} : { concurrency }),
      backoff: {
        type: backoffType ?? base.backoff.type,
        delay: delay ?? base.backoff.delay,
      },
    };
  }

  return {
    redisUrl,
    safeRedisUrl: redactConnectionUrl(redisUrl),
    presets: resolveRetryPresets(overrides),
    prefix: env.QUEUE_PREFIX?.trim() || DEFAULT_PREFIX,
    relayBatchSize:
      readPositiveInt(env.OUTBOX_BATCH_SIZE, 'OUTBOX_BATCH_SIZE') ?? DEFAULT_RELAY_BATCH_SIZE,
    relayPollIntervalMs:
      readPositiveInt(env.OUTBOX_POLL_INTERVAL_MS, 'OUTBOX_POLL_INTERVAL_MS') ??
      DEFAULT_RELAY_POLL_INTERVAL_MS,
    relayMaxAttempts:
      readPositiveInt(env.OUTBOX_MAX_ATTEMPTS, 'OUTBOX_MAX_ATTEMPTS') ?? DEFAULT_RELAY_MAX_ATTEMPTS,
  };
}
