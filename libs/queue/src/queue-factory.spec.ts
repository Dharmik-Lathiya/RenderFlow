import { defaultJobOptions, deterministicJobId } from './queue-factory';
import { RETRY_PRESETS } from './retry-presets';
import { QUEUE_NAMES } from '@renderflow/common';

describe('deterministicJobId', () => {
  it('produces a stable id so a redelivered outbox event is deduplicated', () => {
    expect(deterministicJobId('generation', 'job-1')).toBe('generation:job-1');
    expect(deterministicJobId('generation', 'job-1')).toBe(
      deterministicJobId('generation', 'job-1'),
    );
  });

  it('keeps publish and generation ids in separate namespaces', () => {
    expect(deterministicJobId('publish', 'x')).not.toBe(deterministicJobId('generation', 'x'));
  });
});

describe('defaultJobOptions', () => {
  it('carries the queue retry policy onto every enqueued job', () => {
    expect(defaultJobOptions(RETRY_PRESETS[QUEUE_NAMES.MEDIA])).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
    });
  });

  it('keeps failed jobs around so the DLQ and admin replay can inspect them', () => {
    expect(defaultJobOptions(RETRY_PRESETS[QUEUE_NAMES.CONTENT]).removeOnFail).toBe(false);
  });

  it('bounds completed jobs so Redis does not grow without limit', () => {
    expect(defaultJobOptions(RETRY_PRESETS[QUEUE_NAMES.CONTENT]).removeOnComplete).toEqual({
      age: 3_600,
      count: 1_000,
    });
  });

  it('copies the backoff object rather than sharing the preset', () => {
    const preset = RETRY_PRESETS[QUEUE_NAMES.CONTENT];
    const options = defaultJobOptions(preset);
    expect(options.backoff).not.toBe(preset.backoff);
    expect(options.backoff).toEqual(preset.backoff);
  });
});
