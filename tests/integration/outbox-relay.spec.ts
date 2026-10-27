import { eq } from 'drizzle-orm';

import { generationJobs, outboxEvents } from '@renderflow/db';
import {
  InMemoryPublisher,
  OutboxRelay,
  countAbandoned,
  countPending,
  relayOnce,
} from '@renderflow/outbox';
import { reserve } from '@renderflow/credits';

import { createUserWithBonus } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * The outbox relay against a real database (AGENTS.md rule 6, PROJECT.md
 * section 6).
 *
 * The point of the outbox is that a crash between "the transaction committed"
 * and "the queue got the message" loses nothing. That is only true if the relay
 * reads committed rows, publishes them, and marks them processed - and these
 * tests poke each of those steps, including the awkward ones: two relays racing,
 * a publisher that dies mid-batch, and a relay that marks nothing.
 *
 * `InMemoryPublisher` is used rather than BullMQ because Redis is not part of
 * this environment. What is under test here is the relay, not the queue.
 */

describe('outbox relay', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
  });

  const WORKSPACE = '11111111-1111-4111-8111-111111111111';

  /** Emits `count` job.created events the way the API does. */
  async function emit(count: number): Promise<string[]> {
    const user = await createUserWithBonus(db, { bonus: 500 });
    const ids: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const jobId = await db.transaction(async (tx) => {
        const reservation = await reserve(tx, {
          userId: user.id,
          kind: 'CAPTION',
          workspaceId: WORKSPACE,
        });
        return reservation.jobId;
      });
      ids.push(jobId);
    }

    return ids;
  }

  async function rows() {
    return db
      .select({
        id: outboxEvents.id,
        processedAt: outboxEvents.processedAt,
        attempts: outboxEvents.attempts,
      })
      .from(outboxEvents)
      .orderBy(outboxEvents.createdAt);
  }

  it('publishes pending events and marks them processed', async () => {
    const jobIds = await emit(3);
    const publisher = new InMemoryPublisher();

    const outcome = await relayOnce(db, publisher);

    expect(outcome).toMatchObject({ published: 3, failed: 0 });
    expect(publisher.published.map((m) => m.jobId).sort()).toEqual(
      jobIds.map((id) => `generation-${id}`).sort(),
    );

    const after = await rows();
    expect(after.every((row) => row.processedAt !== null)).toBe(true);
    // Attempts is stamped as the claim, so a relay that dies mid-batch does not
    // leave the rows looking untouched.
    expect(after.map((r) => r.attempts)).toEqual([1, 1, 1]);
  });

  it('publishes the job payload verbatim so the worker can act on it', async () => {
    const [jobId] = await emit(1);
    const publisher = new InMemoryPublisher();

    await relayOnce(db, publisher);

    expect(publisher.published[0]).toMatchObject({
      queue: 'content',
      payload: { eventType: 'job.created', jobId, workspaceId: WORKSPACE, kind: 'CAPTION' },
    });
  });

  it('does nothing when there is nothing pending', async () => {
    const publisher = new InMemoryPublisher();

    const outcome = await relayOnce(db, publisher);

    expect(outcome).toMatchObject({ published: 0, failed: 0 });
    expect(publisher.published).toEqual([]);
  });

  it('does not republish an event it already published', async () => {
    await emit(2);
    const publisher = new InMemoryPublisher();

    await relayOnce(db, publisher);
    const second = await relayOnce(db, publisher);

    expect(second.published).toBe(0);
    // The one and only copy reached the queue, so a second relay pass cannot
    // enqueue the same generation twice.
    expect(publisher.published).toHaveLength(2);
  });

  it('leaves a failed publish unprocessed so the next tick retries it', async () => {
    await emit(1);
    const publisher = new InMemoryPublisher();
    publisher.failNext(1);
    const errors: Array<{ eventType: string; aggregateId: string }> = [];

    const failed = await relayOnce(db, publisher, {
      onPublishError: (event) => errors.push(event),
    });

    expect(failed).toMatchObject({ published: 0, failed: 1 });
    expect((await rows())[0]).toMatchObject({ processedAt: null, attempts: 1 });
    // The reason is observable, not just a failed count. A silent publish
    // failure is how a bad BullMQ job id stranded every generation unnoticed.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ eventType: 'job.created' });

    const retried = await relayOnce(db, publisher);

    const settled = (await rows())[0];
    expect(retried.published).toBe(1);
    expect(settled?.processedAt).not.toBeNull();
  });

  it('keeps draining the batch after one publish throws', async () => {
    await emit(3);
    const publisher = new InMemoryPublisher();
    publisher.failNext(1);

    const outcome = await relayOnce(db, publisher);

    // One bad message must not stop the relay draining the rest: a poison event
    // in the middle of a batch would otherwise block every generation behind it.
    expect(outcome).toMatchObject({ published: 2, failed: 1 });
  });

  it('counts events that have exhausted their attempts', async () => {
    await emit(1);
    const publisher = new InMemoryPublisher();
    publisher.failNext(9);
    // The same limit on every call: `relayOnce` defaults to 10, so leaving it
    // off the relay calls while asking `countAbandoned` about a limit of 3
    // would test two different configurations and prove nothing.
    const limit = { maxAttempts: 3 };

    await relayOnce(db, publisher, limit);
    expect(await countAbandoned(db, 3)).toBe(0);

    await relayOnce(db, publisher, limit);
    await relayOnce(db, publisher, limit);

    // Attempts is stamped as the claim, so an event reaches the limit on its
    // third failed publish. It then stops being retried and surfaces for a human
    // instead of blocking the queue forever.
    expect(await countAbandoned(db, 3)).toBe(1);

    const fourth = await relayOnce(db, publisher, limit);

    expect(fourth.published).toBe(0);
    expect(fourth.failed).toBe(0);
    expect(publisher.published).toEqual([]);
  });

  it('publishes in creation order', async () => {
    const jobIds = await emit(3);
    const publisher = new InMemoryPublisher();

    await relayOnce(db, publisher);

    // Ordering matters because downstream stages depend on ordering of events.
    // The claim is `ORDER BY created_at`, so the sequence survives.
    expect(publisher.published.map((m) => m.jobId)).toEqual(jobIds.map((id) => `generation-${id}`));
  });

  it('respects the batch size', async () => {
    await emit(5);
    const publisher = new InMemoryPublisher();

    const first = await relayOnce(db, publisher, { batchSize: 2 });

    expect(first.published).toBe(2);
    expect(await countPending(db)).toBe(3);
  });

  it('two concurrent relays enqueue each job exactly once', async () => {
    await emit(4);

    // ONE publisher, because two relays are two clients of one queue. BullMQ's
    // jobId dedupe lives in the shared Redis, so a duplicate publish by either
    // relay collapses for both. Two separate InMemoryPublishers would model two
    // separate queues and would make the cross-relay duplicate invisible -
    // which is exactly the bug this test exists to catch.
    const queue = new InMemoryPublisher();

    // DRAIN, rather than assuming one pass claims every row.
    //
    // Two relays of `batchSize: 2` look like they must partition four events -
    // and they usually do - but SKIP LOCKED only hides rows locked at the
    // instant of the scan. A relay that starts while the other is between
    // "published" and "marked processed" re-claims those rows, spends its two
    // slots on duplicates, and leaves later events for the next tick. That is
    // the at-least-once behaviour documented on `relayOnce`: the row is not
    // lost, it is picked up on the next pass, which is what the production loop
    // does every interval.
    //
    // Asserting `published` after a SINGLE pass therefore asserted a partition
    // guarantee the design explicitly disclaims, and failed roughly once in a
    // few hundred runs under load. What matters - exactly-once enqueue and
    // nothing left behind - is asserted below, and is asserted more strongly
    // because the outbox is allowed to finish.
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.all([
        relayOnce(db, queue, { batchSize: 2 }),
        relayOnce(db, queue, { batchSize: 2 }),
      ]);
      if ((await countPending(db)) === 0) {
        break;
      }
    }

    expect(queue.published).toHaveLength(4);
    expect(new Set(queue.published.map((m) => m.jobId)).size).toBe(4);
    await expect(countPending(db)).resolves.toBe(0);
  });

  it('may publish the same event twice, and the queue collapses it', async () => {
    // The documented behaviour, pinned rather than left implicit: the relay is
    // at-least-once, `calls` records the duplicate, and `published` does not.
    // SKIP LOCKED cannot prevent the duplicate - closing the window would mean
    // holding a transaction open across a call to Redis.
    await emit(1);
    const queue = new InMemoryPublisher();

    await relayOnce(db, queue, { maxAttempts: 1 });
    const first = (await rows())[0];
    await db
      .update(outboxEvents)
      .set({ processedAt: null, attempts: 0 })
      .where(eq(outboxEvents.id, first?.id as string));
    await relayOnce(db, queue, { maxAttempts: 1 });

    expect(queue.calls).toHaveLength(2);
    expect(queue.published).toHaveLength(1);
  });

  it('collapses a duplicate publish on the deterministic job id', async () => {
    const [jobId] = await emit(1);
    const publisher = new InMemoryPublisher();

    // Simulates the relay crashing between publish and mark-processed: the row
    // is still pending, so the next poll republishes it. The queue sees the same
    // jobId twice and keeps one.
    await relayOnce(db, publisher, { maxAttempts: 1 });
    const first = (await rows())[0];
    await db
      .update(outboxEvents)
      .set({ processedAt: null, attempts: 0 })
      .where(eq(outboxEvents.id, first?.id as string));

    await relayOnce(db, publisher, { maxAttempts: 1 });

    expect(publisher.calls).toHaveLength(2);
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.jobId).toBe(`generation-${jobId}`);
  });

  it('leaves a job untouched: publishing an event runs nothing', async () => {
    const [jobId] = await emit(1);

    await relayOnce(db, new InMemoryPublisher());

    // The relay's job is to hand the work over. The job still has not run, so
    // nothing about it may have changed yet.
    const [job] = await db
      .select({
        status: generationJobs.status,
        stage: generationJobs.stage,
        captured: generationJobs.captured,
      })
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId as string));

    expect(job).toMatchObject({ status: 'PENDING', stage: 'PLAN', captured: 0 });
  });

  it('survives an event whose payload is not the shape it expects', async () => {
    await emit(1);
    // A hand-written row with a junk payload: the relay's job is to deliver it,
    // and validation belongs to the worker that consumes it. Swallowing it here
    // would strand it with no record of why.
    await db.insert(outboxEvents).values({
      aggregateType: 'JOB',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      eventType: 'job.created',
      dedupeKey: 'JOB:22222222-2222-4222-8222-222222222222:job.created',
      payload: { nonsense: true },
    });

    const publisher = new InMemoryPublisher();
    const outcome = await relayOnce(db, publisher);

    expect(outcome.published).toBe(2);
    expect(publisher.published.some((m) => m.payload.nonsense === true)).toBe(true);
  });

  it('counts pending events for a readiness probe', async () => {
    await emit(2);
    expect(await countPending(db)).toBe(2);

    await relayOnce(db, new InMemoryPublisher());

    expect(await countPending(db)).toBe(0);
  });

  describe('the polling loop', () => {
    it('drains a backlog on its own', async () => {
      await emit(3);
      const publisher = new InMemoryPublisher();
      const relay = new OutboxRelay(db, publisher, { pollIntervalMs: 10 });

      const controller = new AbortController();
      // Polling for the condition rather than sleeping a fixed time: a sleep is
      // either flaky or slow depending on the machine, and it would be testing
      // the scheduler instead of the relay.
      const running = relay.run(controller.signal);
      await waitFor(() => publisher.published.length >= 3);
      controller.abort();
      await running;

      expect(publisher.published).toHaveLength(3);
      await expect(countPending(db)).resolves.toBe(0);
    });

    it('stops on abort rather than spinning forever', async () => {
      const publisher = new InMemoryPublisher();
      const relay = new OutboxRelay(db, publisher, { pollIntervalMs: 5 });
      const controller = new AbortController();

      const running = relay.run(controller.signal);
      controller.abort();

      // Without the abort being honoured this would never resolve, and the test
      // would hit the jest timeout instead of failing with a readable message.
      await expect(running).resolves.toBeUndefined();
    });

    it('stops when told to, without an abort', async () => {
      const relay = new OutboxRelay(db, new InMemoryPublisher(), { pollIntervalMs: 5 });

      const running = relay.run(new AbortController().signal);
      relay.stop();

      await expect(running).resolves.toBeUndefined();
    });
  });
});

/** Polls until `done` or the test timeout - never a fixed sleep. */
async function waitFor(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error('condition was never met');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
