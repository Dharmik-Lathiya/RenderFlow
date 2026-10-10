import type { Queue } from 'bullmq';

import { RETRY_PRESETS } from '@renderflow/queue';

import { BullMqPublisher } from './bullmq-publisher';

/**
 * `BullMqPublisher` against a stubbed queue factory.
 *
 * Redis is not available in this environment, and a test that needed it would
 * only prove that Redis is up. What is worth testing here is the publisher's own
 * logic, and there is a real bug hiding in it if it goes untested: if
 * `queueFor` did not cache, every message would open its own BullMQ connection.
 * A relay draining a backlog would open fifty connections, and Redis's default
 * limit is far below that - so the code under test is exactly the kind that
 * looks right and fails only under load.
 */

const created: Array<{ name: string; preset: unknown }> = [];
const queues: Array<{ add: jest.Mock; close: jest.Mock }> = [];

jest.mock('@renderflow/queue', () => ({
  ...jest.requireActual('@renderflow/queue'),
  createQueue: jest.fn((name: string, preset: unknown) => {
    created.push({ name, preset });
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    queues.push(queue);
    return queue as unknown as Queue;
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createQueue } = require('@renderflow/queue') as { createQueue: jest.Mock };

const factory = { redisUrl: 'redis://localhost:6379', prefix: 'renderflow' };

describe('BullMqPublisher', () => {
  beforeEach(() => {
    created.length = 0;
    queues.length = 0;
    createQueue.mockClear();
  });

  it('adds the payload to the named queue', async () => {
    const publisher = new BullMqPublisher(factory);

    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: { jobId: 'a' } });

    expect(queues[0]?.add).toHaveBeenCalledWith(
      'content',
      { jobId: 'a' },
      { jobId: 'generation:a' },
    );
  });

  it('creates the queue with its documented retry preset', async () => {
    const publisher = new BullMqPublisher(factory);

    await publisher.publish({ queue: 'media', jobId: 'generation:a', payload: {} });

    // The preset decides attempts and backoff. A publisher that passed the wrong
    // one - or none - would silently change every worker's retry behaviour.
    expect(createQueue).toHaveBeenCalledWith('media', RETRY_PRESETS.media, factory);
  });

  it('reuses one connection per queue instead of one per message', async () => {
    const publisher = new BullMqPublisher(factory);

    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    await publisher.publish({ queue: 'content', jobId: 'generation:b', payload: {} });
    await publisher.publish({ queue: 'content', jobId: 'generation:c', payload: {} });

    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(queues[0]?.add).toHaveBeenCalledTimes(3);
  });

  it('opens a separate connection per distinct queue', async () => {
    const publisher = new BullMqPublisher(factory);

    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    await publisher.publish({ queue: 'media', jobId: 'generation:a', payload: {} });

    expect(created.map((c) => c.name)).toEqual(['content', 'media']);
  });

  it('passes the same jobId through so BullMQ can drop a duplicate', async () => {
    // The relay is at-least-once: a crash between publish and mark-processed
    // republishes. The identical jobId is what stops that becoming a second
    // generation.
    const publisher = new BullMqPublisher(factory);

    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });

    const ids = (queues[0]?.add.mock.calls as [string, unknown, { jobId: string }][]).map(
      (call) => call[2].jobId,
    );
    expect(ids).toEqual(['generation:a', 'generation:a']);
  });

  it('propagates a publish failure so the relay can retry', async () => {
    const publisher = new BullMqPublisher(factory);
    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    (queues[0]?.add as jest.Mock).mockRejectedValueOnce(new Error('redis down'));

    // Swallowing this would mark the event processed with nothing delivered, and
    // the generation would silently never run.
    await expect(
      publisher.publish({ queue: 'content', jobId: 'generation:b', payload: {} }),
    ).rejects.toThrow('redis down');
  });

  it('closes every connection it opened', async () => {
    const publisher = new BullMqPublisher(factory);
    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    await publisher.publish({ queue: 'media', jobId: 'generation:a', payload: {} });

    await publisher.close();

    expect(queues.every((q) => q.close.mock.calls.length === 1)).toBe(true);
  });

  it('does not reopen a queue after closing', async () => {
    // Closing has to clear the cache, or a worker that drains, shuts down and is
    // somehow still running would hand out a closed queue.
    const publisher = new BullMqPublisher(factory);
    await publisher.publish({ queue: 'content', jobId: 'generation:a', payload: {} });
    await publisher.close();
    createQueue.mockClear();

    await publisher.publish({ queue: 'content', jobId: 'generation:b', payload: {} });

    expect(createQueue).toHaveBeenCalledTimes(1);
  });

  it('closes cleanly when it never opened anything', async () => {
    const publisher = new BullMqPublisher(factory);

    await expect(publisher.close()).resolves.toBeUndefined();
    expect(createQueue).not.toHaveBeenCalled();
  });
});
