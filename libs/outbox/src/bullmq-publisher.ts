import type { Queue } from 'bullmq';

import type { QueueName } from '@renderflow/common';
import {
  RETRY_PRESETS,
  createQueue,
  deterministicJobId,
  type FactoryOptions,
} from '@renderflow/queue';

import type { JobPublisher, PublishMessage } from './relay';

/**
 * The production `JobPublisher`: BullMQ.
 *
 * Why the duplicate-id defence matters here. The relay publishes and only then
 * marks the row processed, so a relay that dies between the two republishes on
 * its next poll. `add` with the same `jobId` is a no-op in BullMQ, which turns
 * "at least once" delivery into exactly-once enqueue. The outbox alone would
 * have delivered the message twice.
 *
 * Note the consequence of `removeOnFail: false` in the preset: a job id stays
 * taken even after it failed. That is safe only because the id is derived from
 * the generation id, which is unique - a genuinely new generation never reuses
 * one.
 */
export class BullMqPublisher implements JobPublisher {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly factory: FactoryOptions) {}

  private queueFor(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const created = createQueue(name, RETRY_PRESETS[name], this.factory);
    this.queues.set(name, created);
    return created;
  }

  async publish(message: PublishMessage): Promise<void> {
    await this.queueFor(message.queue).add(message.queue, message.payload, {
      // Deterministic on purpose; see the class comment.
      jobId: message.jobId,
    });
  }

  /** Closes every connection this publisher opened. Registered as a SIGTERM drain. */
  async close(): Promise<void> {
    const open = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(open.map((queue) => queue.close()));
  }
}

export { deterministicJobId };
