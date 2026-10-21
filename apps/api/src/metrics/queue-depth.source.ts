import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { ALL_QUEUE_NAMES } from '@renderflow/common';
import type { QueueDepthSource } from '@renderflow/observability';
import { createQueue, loadQueueConfig } from '@renderflow/queue';

/**
 * Nest token for the queue-depth source.
 *
 * The collector in `libs/observability` knows only the interface, so the
 * observability library never depends on BullMQ (AGENTS.md section 3). This
 * adapter is the one place the API process talks to Redis, and it exists only
 * to answer "how much work is waiting".
 */
export const QUEUE_DEPTH_SOURCE = Symbol('RENDERFLOW_QUEUE_DEPTH_SOURCE');

/**
 * Reads waiting + delayed counts for every queue.
 *
 * `active` is deliberately excluded: an active job is being worked on, and
 * counting it as backlog would make a healthy worker at full concurrency look
 * like a queue that is not draining.
 *
 * Queues are created LAZILY. A `Queue` opens a Redis connection on construction,
 * and the integration suite builds the API application dozens of times without
 * Redis; connecting at boot would turn every one of those into a timeout. The
 * first scrape is the first time a connection is worth paying for.
 */
@Injectable()
export class BullQueueDepthSource implements QueueDepthSource, OnModuleDestroy {
  private queues: Queue[] | null = null;

  async depths(): Promise<Record<string, number>> {
    const queues = this.ensureQueues();

    const entries = await Promise.all(
      queues.map(async (queue) => {
        const counts = await queue.getJobCounts('waiting', 'delayed');
        return [queue.name, (counts.waiting ?? 0) + (counts.delayed ?? 0)] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  async onModuleDestroy(): Promise<void> {
    const queues = this.queues;
    this.queues = null;

    if (queues !== null) {
      await Promise.all(queues.map((queue) => queue.close()));
    }
  }

  private ensureQueues(): Queue[] {
    if (this.queues !== null) {
      return this.queues;
    }

    const config = loadQueueConfig();

    this.queues = ALL_QUEUE_NAMES.map((name) =>
      createQueue(name, config.presets[name], {
        redisUrl: config.redisUrl,
        prefix: config.prefix,
      }),
    );

    return this.queues;
  }
}
