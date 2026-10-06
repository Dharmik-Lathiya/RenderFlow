import { QUEUE_NAMES, type QueueName } from '@renderflow/common';

/**
 * Retry and concurrency presets. PROJECT.md section 8.
 *
 * AGENTS.md rule: "Use exponential backoff from libs/queue presets. Never write
 * ad-hoc setTimeout retries." These are the only retry numbers in the codebase,
 * and they are overridable per environment (see queue-config.ts) so a test can
 * fail fast without waiting out a real backoff.
 */

export type BackoffType = 'exponential' | 'fixed';

export interface RetryPreset {
  /** Total attempts including the first. */
  attempts: number;
  /** Concurrent jobs a worker may process for this queue. */
  concurrency: number;
  backoff: {
    type: BackoffType;
    /** Base delay in milliseconds; `exponential` multiplies by 2^attempt. */
    delay: number;
  };
}

/**
 * Documented defaults. Values for content/media/publish/analytics come straight
 * from the PROJECT.md section 8 table; `notifications` and `dlq` are not in that
 * table and are our assumptions (recorded in the Phase 0 report):
 * notifications mirrors content, dlq is terminal so it gets a single attempt.
 */
export const RETRY_PRESETS: Readonly<Record<QueueName, RetryPreset>> = {
  [QUEUE_NAMES.CONTENT]: {
    attempts: 3,
    concurrency: 5,
    backoff: { type: 'exponential', delay: 5_000 },
  },
  [QUEUE_NAMES.MEDIA]: {
    attempts: 3,
    concurrency: 2,
    backoff: { type: 'exponential', delay: 15_000 },
  },
  [QUEUE_NAMES.PUBLISH]: {
    attempts: 5,
    concurrency: 10,
    backoff: { type: 'exponential', delay: 30_000 },
  },
  [QUEUE_NAMES.ANALYTICS]: {
    attempts: 3,
    concurrency: 3,
    backoff: { type: 'fixed', delay: 60_000 },
  },
  [QUEUE_NAMES.NOTIFICATIONS]: {
    attempts: 3,
    concurrency: 5,
    backoff: { type: 'exponential', delay: 5_000 },
  },
  [QUEUE_NAMES.DLQ]: {
    attempts: 1,
    concurrency: 1,
    backoff: { type: 'fixed', delay: 0 },
  },
};

/** Total delay before attempt `attempt` (1-based), used by tests and docs. */
export function backoffDelayMs(preset: RetryPreset, attempt: number): number {
  if (attempt < 2) {
    return 0;
  }
  if (preset.backoff.type === 'fixed') {
    return preset.backoff.delay;
  }
  return preset.backoff.delay * 2 ** (attempt - 2);
}

/** Freezes the presets so no caller can mutate the shared table. */
export function resolveRetryPresets(
  overrides: Partial<Record<QueueName, Partial<RetryPreset>>> = {},
): Readonly<Record<QueueName, RetryPreset>> {
  const resolved = {} as Record<QueueName, RetryPreset>;
  for (const [queue, preset] of Object.entries(RETRY_PRESETS) as [QueueName, RetryPreset][]) {
    const override = overrides[queue];
    resolved[queue] = {
      attempts: override?.attempts ?? preset.attempts,
      concurrency: override?.concurrency ?? preset.concurrency,
      backoff: override?.backoff ?? { ...preset.backoff },
    };
  }
  return resolved;
}

/** BullMQ worker options derived from a preset. */
export function toWorkerOptions(preset: RetryPreset): {
  concurrency: number;
  attempts: number;
  backoff: { type: BackoffType; delay: number };
} {
  return {
    concurrency: preset.concurrency,
    attempts: preset.attempts,
    backoff: { ...preset.backoff },
  };
}
