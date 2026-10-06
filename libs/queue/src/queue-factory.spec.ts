import { QUEUE_NAMES } from '@renderflow/common';

import {
  connectionOptionsFor,
  defaultJobOptions,
  deterministicJobId,
  jobData,
} from './queue-factory';
import { RETRY_PRESETS } from './retry-presets';

const FACTORY = { redisUrl: 'redis://localhost:6379' };

describe('connectionOptionsFor', () => {
  it('blocks forever so a producer waits for Redis to recover', () => {
    // Producers must not give up: an event that cannot be enqueued immediately
    // is still enqueued a moment later, rather than lost.
    expect(connectionOptionsFor(FACTORY).maxRetriesPerRequest).toBeNull();
  });

  it('parses the host and port out of the url', () => {
    expect(connectionOptionsFor({ redisUrl: 'redis://cache:6380/2' })).toMatchObject({
      host: 'cache',
      port: 6380,
      db: 2,
    });
  });

  it('applies the default prefix', () => {
    expect(deterministicJobId('generation', 'job-1')).toBe('generation:job-1');
  });
});

describe('jobData', () => {
  it('returns the typed payload', () => {
    const job = { data: { jobId: 'job-1', attempt: 2 } };
    expect(jobData<{ jobId: string; attempt: number }>(job as never)).toEqual({
      jobId: 'job-1',
      attempt: 2,
    });
  });

  it('does not mutate the job', () => {
    const job = { data: { attempt: 1 } };
    jobData(job as never);
    expect(job.data).toEqual({ attempt: 1 });
  });
});

describe('queue defaults', () => {
  it('applies each queue retry policy to its jobs', () => {
    for (const queue of [QUEUE_NAMES.CONTENT, QUEUE_NAMES.MEDIA, QUEUE_NAMES.PUBLISH]) {
      const options = defaultJobOptions(RETRY_PRESETS[queue]);
      expect(options.attempts).toBe(RETRY_PRESETS[queue].attempts);
      expect(options.backoff).toEqual(RETRY_PRESETS[queue].backoff);
    }
  });
});
