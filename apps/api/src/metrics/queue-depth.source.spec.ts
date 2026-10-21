import type { Queue } from 'bullmq';

import { ALL_QUEUE_NAMES } from '@renderflow/common';
import { createQueue, loadQueueConfig } from '@renderflow/queue';

import { BullQueueDepthSource, QUEUE_DEPTH_SOURCE } from './queue-depth.source';

/**
 * The queue-depth adapter.
 *
 * No Redis here: the adapter's logic is "ask each queue for waiting + delayed,
 * add them up, and do not open a connection until somebody scrapes". That is
 * worth a test precisely because a `Queue` constructor does connect - the lazy
 * behaviour is what keeps every API boot in the integration suite fast.
 */

jest.mock('@renderflow/queue', () => ({
  loadQueueConfig: jest.fn(() => ({
    redisUrl: 'redis://localhost:6379',
    safeRedisUrl: 'redis://localhost:6379',
    presets: {},
    prefix: 'renderflow-test',
  })),
  createQueue: jest.fn(),
}));

const createQueueMock = jest.mocked(createQueue);
const loadQueueConfigMock = jest.mocked(loadQueueConfig);

interface FakeQueue {
  name: string;
  getJobCounts: jest.Mock;
  close: jest.Mock;
}

function installFakeQueues(counts: { waiting?: number; delayed?: number; active?: number } = {}) {
  const created: FakeQueue[] = [];

  createQueueMock.mockImplementation((name: string) => {
    const queue: FakeQueue = {
      name,
      getJobCounts: jest.fn(async () => ({
        waiting: counts.waiting ?? 0,
        delayed: counts.delayed ?? 0,
        active: counts.active ?? 0,
      })),
      close: jest.fn(async () => undefined),
    };
    created.push(queue);
    return queue as unknown as Queue;
  });

  return created;
}

describe('BullQueueDepthSource', () => {
  it('exposes a Nest token distinct from the interface name', () => {
    expect(typeof QUEUE_DEPTH_SOURCE).toBe('symbol');
  });

  it('opens no Redis connection until the first scrape', async () => {
    installFakeQueues();
    const source = new BullQueueDepthSource();

    expect(createQueueMock).not.toHaveBeenCalled();

    await source.depths();

    expect(createQueueMock).toHaveBeenCalledTimes(ALL_QUEUE_NAMES.length);
  });

  it('adds waiting and delayed, and ignores active work', async () => {
    installFakeQueues({ waiting: 3, delayed: 2, active: 99 });
    const source = new BullQueueDepthSource();

    const depths = await source.depths();

    // Active jobs are being worked on; counting them as backlog would make a
    // healthy worker at full concurrency look like a stuck queue.
    expect(Object.values(depths)).toEqual(ALL_QUEUE_NAMES.map(() => 5));
    expect(Object.keys(depths).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
  });

  it('treats a missing count as zero rather than NaN', async () => {
    createQueueMock.mockImplementation(
      (name: string) =>
        ({
          name,
          getJobCounts: async () => ({ waiting: undefined, delayed: null }),
          close: async () => undefined,
        }) as unknown as Queue,
    );

    const depths = await new BullQueueDepthSource().depths();

    expect(Object.values(depths)).toEqual(ALL_QUEUE_NAMES.map(() => 0));
  });

  it('reuses its connections across scrapes', async () => {
    installFakeQueues({ waiting: 1 });
    const source = new BullQueueDepthSource();

    await source.depths();
    await source.depths();

    expect(createQueueMock).toHaveBeenCalledTimes(ALL_QUEUE_NAMES.length);
    expect(loadQueueConfigMock).toHaveBeenCalledTimes(1);
  });

  it('closes every queue on shutdown and can be re-created afterwards', async () => {
    const queues = installFakeQueues();
    const source = new BullQueueDepthSource();

    await source.depths();
    await source.onModuleDestroy();

    for (const queue of queues) {
      expect(queue.close).toHaveBeenCalledTimes(1);
    }

    await source.depths();
    expect(createQueueMock).toHaveBeenCalledTimes(ALL_QUEUE_NAMES.length * 2);
  });

  it('shuts down cleanly even if nothing was ever scraped', async () => {
    installFakeQueues();
    const source = new BullQueueDepthSource();

    await expect(source.onModuleDestroy()).resolves.toBeUndefined();
    expect(createQueueMock).not.toHaveBeenCalled();
  });
});
