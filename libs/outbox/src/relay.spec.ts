import { QUEUE_NAMES } from '@renderflow/common';
import {
  InMemoryPublisher,
  countAbandoned,
  countPending,
  delayForEvent,
  queueForEvent,
  relayOnce,
} from './relay';

/**
 * Pure behaviour of the relay's routing and attempt accounting.
 *
 * The database-backed paths - claiming, ordering, SKIP LOCKED - are in
 * tests/integration, where there is a real outbox_events table to be correct
 * about. Here it is the decisions that can be wrong without a crash.
 */
describe('queueForEvent', () => {
  it('routes a created job to the content queue', () => {
    expect(queueForEvent('job.created')).toBe('content');
  });

  it('routes a content stage back to the content queue', () => {
    expect(queueForEvent('job.stage_completed', { stage: 'PLAN' })).toBe('content');
    expect(queueForEvent('job.stage_completed', { stage: 'SCRIPT' })).toBe('content');
  });

  it('routes a media stage to the media queue', () => {
    // This is the hand-off that lets a reel cross from content-worker to
    // media-worker. Routing these to content would mean media-worker never runs.
    expect(queueForEvent('job.stage_completed', { stage: 'IMAGE' })).toBe('media');
    expect(queueForEvent('job.stage_completed', { stage: 'VOICE' })).toBe('media');
    expect(queueForEvent('job.stage_completed', { stage: 'RENDER' })).toBe('media');
  });

  it('routes a scheduled publish to the publish queue', () => {
    expect(queueForEvent('post.scheduled')).toBe('publish');
  });

  it('wakes analytics when a post publishes', () => {
    // Without this route the event falls through to the content queue, so the
    // analytics worker only ever sees its poll and a fresh post waits a full
    // cycle before it has numbers.
    expect(queueForEvent('post.published', { postId: 'post-1' })).toBe('analytics');
  });

  it('routes publish failures to notifications', () => {
    expect(queueForEvent('post.publish_failed')).toBe('notifications');
  });

  it('falls back to content for an event it does not recognise', () => {
    // Better a default queue than a silent drop: an unroutable event that is
    // still recorded beats an event that vanishes.
    expect(queueForEvent('something.new')).toBe('content');
  });

  it('falls back to content for a stage event it cannot read', () => {
    // A payload that lost its stage still has to go somewhere. Content is the
    // right default because a content worker declines stages it does not own
    // rather than running them.
    expect(queueForEvent('job.stage_completed')).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForEvent('job.stage_completed', {})).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForEvent('job.stage_completed', { stage: 42 })).toBe(QUEUE_NAMES.CONTENT);
    expect(queueForEvent('job.stage_completed', { stage: 'MADE_UP' })).toBe(QUEUE_NAMES.CONTENT);
  });

  it('ignores the payload for events that do not route by stage', () => {
    expect(queueForEvent('job.created', { stage: 'RENDER' })).toBe(QUEUE_NAMES.CONTENT);
  });
});

describe('delayForEvent', () => {
  const now = Date.parse('2026-03-01T12:00:00.000Z');

  it('leaves every event but a scheduled publish undelayed', () => {
    // `undefined`, not 0. The publisher treats the two differently: 0 means
    // "put it in the queue now", undefined means "do not pass a delay at all",
    // which is what every other queue already relies on.
    expect(
      delayForEvent('job.created', { scheduledAt: '2026-03-01T13:00:00.000Z' }, now),
    ).toBeUndefined();
    expect(delayForEvent('post.publish_failed', {}, now)).toBeUndefined();
  });

  it('measures the delay from the scheduled time, not the request time', () => {
    // The relay may publish minutes after the transaction commits. Computing the
    // delay from the original request would queue the message at the wrong time.
    expect(delayForEvent('post.scheduled', { scheduledAt: '2026-03-01T12:05:00.000Z' }, now)).toBe(
      5 * 60 * 1_000,
    );
  });

  it('clamps a time already in the past to zero', () => {
    // "Publish at the next poll", not "publish in the negative past".
    expect(delayForEvent('post.scheduled', { scheduledAt: '2026-03-01T11:59:00.000Z' }, now)).toBe(
      0,
    );
    expect(delayForEvent('post.scheduled', { scheduledAt: '2026-03-01T12:00:00.000Z' }, now)).toBe(
      0,
    );
  });

  it('returns nothing when the payload cannot say when', () => {
    // Better an immediate job that the worker then checks `scheduled_for` against,
    // than a delay derived from a value nobody could read.
    expect(delayForEvent('post.scheduled', undefined, now)).toBeUndefined();
    expect(delayForEvent('post.scheduled', {}, now)).toBeUndefined();
    expect(delayForEvent('post.scheduled', { scheduledAt: 42 }, now)).toBeUndefined();
    expect(delayForEvent('post.scheduled', { scheduledAt: 'not a date' }, now)).toBeUndefined();
  });
});

describe('InMemoryPublisher', () => {
  it('records what it published', async () => {
    const publisher = new InMemoryPublisher();

    await publisher.publish({ queue: 'content', jobId: 'generation-1', payload: { a: 1 } });

    expect(publisher.published).toEqual([
      { queue: 'content', jobId: 'generation-1', payload: { a: 1 } },
    ]);
  });

  it('keeps every call but enqueues a repeated jobId only once', async () => {
    const publisher = new InMemoryPublisher();

    await publisher.publish({ queue: 'content', jobId: 'generation-1', payload: {} });
    await publisher.publish({ queue: 'content', jobId: 'generation-1', payload: {} });
    await publisher.publish({ queue: 'content', jobId: 'generation-2', payload: {} });

    // Mirrors BullMQ's behaviour on a duplicate jobId. If this class recorded
    // both, every test of the relay's delivery guarantee would be measuring a
    // publisher production does not have.
    expect(publisher.calls).toHaveLength(3);
    expect(publisher.published.map((m) => m.jobId)).toEqual(['generation-1', 'generation-2']);
  });

  it('dedupes per queue, not per jobId alone', async () => {
    const publisher = new InMemoryPublisher();

    await publisher.publish({ queue: 'content', jobId: 'generation-1', payload: {} });
    await publisher.publish({ queue: 'media', jobId: 'generation-1', payload: {} });

    // BullMQ scopes job ids per queue. It has to: a reel's stages route to
    // `content` and then to `media` under the same id, and deduping on the id
    // alone would swallow the hand-off that lets media-worker run at all.
    expect(publisher.published.map((m) => m.queue)).toEqual(['content', 'media']);
  });

  it('throws for a configured number of failures, then recovers', async () => {
    const publisher = new InMemoryPublisher();
    publisher.failNext(2);

    await expect(
      publisher.publish({ queue: 'content', jobId: 'a', payload: {} }),
    ).rejects.toThrow();
    await expect(
      publisher.publish({ queue: 'content', jobId: 'b', payload: {} }),
    ).rejects.toThrow();
    await expect(
      publisher.publish({ queue: 'content', jobId: 'c', payload: {} }),
    ).resolves.toBeUndefined();

    // Only the recovered one is recorded.
    expect(publisher.published.map((m) => m.jobId)).toEqual(['c']);
    // A failed publish never reached the queue, so it leaves no trace to dedupe
    // against - the retry of the same id must still be enqueued.
    expect(publisher.calls.map((m) => m.jobId)).toEqual(['c']);
  });
});

describe('exports', () => {
  it('exposes the counting helpers the relay uses', () => {
    // Named explicitly so a rename that breaks apps/outbox-relay fails here.
    expect(typeof relayOnce).toBe('function');
    expect(typeof countPending).toBe('function');
    expect(typeof countAbandoned).toBe('function');
  });
});
