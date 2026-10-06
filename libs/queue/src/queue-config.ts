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
}

export class QueueConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueConfigError';
  }
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_PREFIX = 'renderflow';

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
  };
}
