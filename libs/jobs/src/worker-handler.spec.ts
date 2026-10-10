import { ProviderError } from '@renderflow/ai';

import { isFinalAttempt, isPermanent, parseGenerationJob } from './worker-handler';

/**
 * The retry arithmetic, on its own.
 *
 * The full handler needs a database, so it is covered in
 * tests/integration. What is here is the decision - "is this the last attempt,
 * or should we let the queue try again?" - because getting it wrong is expensive
 * in both directions and neither mistake is visible in a passing happy path.
 *
 * The bugs these pin down:
 *  - off-by-one, so a job refunds on attempt 2 of 3 and the user is charged
 *    nothing for a retry that then succeeded;
 *  - refunding on a `TRANSIENT` error at all, which discards credits for a blip;
 *  - treating `PERMANENT` as retryable, which delays the refund by three
 *    backoff intervals for a failure that can never succeed.
 */

describe('isFinalAttempt', () => {
  it('is false on the first of three attempts', () => {
    expect(isFinalAttempt({ attemptsMade: 0, attempts: 3 })).toBe(false);
  });

  it('is false in the middle', () => {
    expect(isFinalAttempt({ attemptsMade: 1, attempts: 3 })).toBe(false);
  });

  it('is true on the last', () => {
    expect(isFinalAttempt({ attemptsMade: 2, attempts: 3 })).toBe(true);
  });

  it('is true immediately when the queue configured a single attempt', () => {
    expect(isFinalAttempt({ attemptsMade: 0, attempts: 1 })).toBe(true);
  });

  it('assumes one attempt when the queue said nothing', () => {
    // A missing `attempts` must not mean "infinite retries": that would pin a
    // reservation forever with no worker left to release it.
    expect(isFinalAttempt({ attemptsMade: 0 })).toBe(true);
  });

  it('honours a configured default over the built-in one', () => {
    expect(isFinalAttempt({ attemptsMade: 1 }, 3)).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 1 }, 2)).toBe(true);
  });

  it('treats more attempts than configured as final', () => {
    // Only reachable if the preset changed under a job already in the queue. The
    // safe answer is to settle it rather than retry forever.
    expect(isFinalAttempt({ attemptsMade: 7, attempts: 3 })).toBe(true);
  });
});

describe('isPermanent', () => {
  it('is true for a permanent provider error', () => {
    expect(isPermanent(new ProviderError('bad prompt', 'PERMANENT'))).toBe(true);
  });

  it('is false for a transient provider error', () => {
    expect(isPermanent(new ProviderError('timeout', 'TRANSIENT'))).toBe(false);
  });

  it('is false for an ordinary error', () => {
    // A database blip is not a provider's permanent verdict; the queue's retries
    // are exactly the right tool for it.
    expect(isPermanent(new Error('connection reset'))).toBe(false);
  });

  it('is false for something that is not an error at all', () => {
    expect(isPermanent(null)).toBe(false);
    expect(isPermanent('nope')).toBe(false);
  });
});

describe('parseGenerationJob', () => {
  const event = {
    eventType: 'job.created' as const,
    jobId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    workspaceId: '00000000-0000-4000-8000-000000000003',
    kind: 'REEL' as const,
    creditsReserved: 30,
  };

  it('accepts a well-formed event and returns the job id', () => {
    expect(parseGenerationJob(event)).toMatchObject({ jobId: event.jobId });
  });

  it('rejects an event whose jobId is not a uuid', () => {
    // Fails at the boundary with a zod error, rather than as a confusing 404
    // once the database has been asked about a job that cannot exist.
    expect(() => parseGenerationJob({ ...event, jobId: 'not-a-uuid' })).toThrow();
  });

  it('rejects an event that never went through a schema', () => {
    // The shape a relay bug would deliver: a raw `outbox_events.payload` blob.
    expect(() => parseGenerationJob({ nonsense: true })).toThrow();
  });

  it('rejects a job.created event with no workspace', () => {
    const { workspaceId: _dropped, ...rest } = event;
    expect(() => parseGenerationJob(rest)).toThrow();
  });

  it('rejects an unknown generation kind', () => {
    expect(() => parseGenerationJob({ ...event, kind: 'POEM' })).toThrow();
  });

  it('rejects a non-object payload', () => {
    expect(() => parseGenerationJob(null)).toThrow();
    expect(() => parseGenerationJob('job.created')).toThrow();
  });
});
