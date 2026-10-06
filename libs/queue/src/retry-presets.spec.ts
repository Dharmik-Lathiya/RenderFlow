import { QUEUE_NAMES } from '@renderflow/common';

import {
  RETRY_PRESETS,
  backoffDelayMs,
  resolveRetryPresets,
  toWorkerOptions,
  type RetryPreset,
} from './retry-presets';

const preset = (attempts: number, type: 'exponential' | 'fixed', delay: number): RetryPreset => ({
  attempts,
  concurrency: 1,
  backoff: { type, delay },
});

describe('RETRY_PRESETS', () => {
  it('matches the PROJECT.md section 8 table', () => {
    expect(RETRY_PRESETS[QUEUE_NAMES.CONTENT]).toEqual({
      attempts: 3,
      concurrency: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    });
    expect(RETRY_PRESETS[QUEUE_NAMES.MEDIA]).toEqual({
      attempts: 3,
      concurrency: 2,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    expect(RETRY_PRESETS[QUEUE_NAMES.PUBLISH]).toEqual({
      attempts: 5,
      concurrency: 10,
      backoff: { type: 'exponential', delay: 30_000 },
    });
    expect(RETRY_PRESETS[QUEUE_NAMES.ANALYTICS]).toEqual({
      attempts: 3,
      concurrency: 3,
      backoff: { type: 'fixed', delay: 60_000 },
    });
  });

  it('keeps media at concurrency 2 because rendering is CPU heavy', () => {
    expect(RETRY_PRESETS[QUEUE_NAMES.MEDIA].concurrency).toBe(2);
  });

  it('makes the DLQ terminal: one attempt, no backoff', () => {
    expect(RETRY_PRESETS[QUEUE_NAMES.DLQ]).toEqual({
      attempts: 1,
      concurrency: 1,
      backoff: { type: 'fixed', delay: 0 },
    });
  });

  it('defines a preset for every queue', () => {
    for (const queue of Object.values(QUEUE_NAMES)) {
      expect(RETRY_PRESETS[queue]).toBeDefined();
      expect(RETRY_PRESETS[queue].attempts).toBeGreaterThan(0);
    }
  });
});

describe('backoffDelayMs', () => {
  it('does not delay the first attempt', () => {
    expect(backoffDelayMs(preset(3, 'exponential', 5_000), 1)).toBe(0);
  });

  it('doubles the base delay for exponential backoff', () => {
    const p = preset(5, 'exponential', 30_000);
    expect(backoffDelayMs(p, 2)).toBe(30_000);
    expect(backoffDelayMs(p, 3)).toBe(60_000);
    expect(backoffDelayMs(p, 4)).toBe(120_000);
    expect(backoffDelayMs(p, 5)).toBe(240_000);
  });

  it('uses a constant delay for fixed backoff', () => {
    const p = preset(3, 'fixed', 60_000);
    expect(backoffDelayMs(p, 2)).toBe(60_000);
    expect(backoffDelayMs(p, 3)).toBe(60_000);
    expect(backoffDelayMs(p, 9)).toBe(60_000);
  });
});

describe('resolveRetryPresets', () => {
  it('returns the defaults when nothing is overridden', () => {
    const resolved = resolveRetryPresets();
    expect(resolved[QUEUE_NAMES.CONTENT]).toEqual(RETRY_PRESETS[QUEUE_NAMES.CONTENT]);
  });

  it('merges partial overrides without dropping other fields', () => {
    const resolved = resolveRetryPresets({ [QUEUE_NAMES.MEDIA]: { attempts: 1 } });
    expect(resolved[QUEUE_NAMES.MEDIA].attempts).toBe(1);
    expect(resolved[QUEUE_NAMES.MEDIA].concurrency).toBe(2);
    expect(resolved[QUEUE_NAMES.MEDIA].backoff).toEqual({ type: 'exponential', delay: 15_000 });
  });

  it('does not let a caller mutate the shared preset table', () => {
    const resolved = resolveRetryPresets({ [QUEUE_NAMES.CONTENT]: { attempts: 1 } });
    (resolved[QUEUE_NAMES.CONTENT] as { attempts: number }).attempts = 99;
    expect(RETRY_PRESETS[QUEUE_NAMES.CONTENT].attempts).toBe(3);
  });
});

describe('toWorkerOptions', () => {
  it('projects a preset onto BullMQ worker options', () => {
    expect(toWorkerOptions(RETRY_PRESETS[QUEUE_NAMES.PUBLISH])).toEqual({
      concurrency: 10,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });
});
