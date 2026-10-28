import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
} from '@renderflow/ai';
import { jobCreatedEventSchema } from '@renderflow/common';
import {
  creditLedger,
  generationJobs,
  jobCheckpoints,
  outboxEvents,
  tryAcquireAdvisoryLock,
} from '@renderflow/db';
import { reserve } from '@renderflow/credits';
import {
  acquireLease,
  handleGenerationJob,
  processJob,
  renewLease,
  releaseLease,
  sweepOnce,
  sweepOrphanedPending,
  findAbandonedOutbox,
  replayOutboxEvent,
  workerIdForProcess,
  type LeaseConfig,
} from '@renderflow/jobs';

import { createUserWithBonus, walletOf } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import { fakeStorage, type FakeStorage } from './helpers/fake-storage';
import {
  createTestPool,
  resolveTestDatabaseUrl,
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Phase 5 DoD (PROJECT.md section 12): "killing `media-worker` at stage IMAGE
 * results in retry on another worker that resumes from checkpoint; after max
 * attempts the job fails and credits are refunded exactly once; chaos test
 * passes."
 *
 * What is and is not exercised here
 * ---------------------------------
 * This suite builds the *state* a kill leaves behind - PROCESSING, a lease
 * nobody will renew, and whatever checkpoints the dead worker managed to write -
 * and asserts what the reaper and the next worker do about it. That is the fast
 * gate: every recovery decision, against a real database.
 *
 * The process death itself is exercised by `tests/chaos/r5-harness.mjs`, which
 * spawns a real worker, SIGKILLs it inside SCRIPT, and resumes the job in a
 * second process. It needs no Redis; R5 is part of `tests/chaos/run.sh`.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONTENT_STAGES = ['PLAN', 'SCRIPT'] as const;
const MEDIA_STAGES = ['IMAGE', 'VOICE', 'RENDER'] as const;

/** Long enough that nothing expires on its own during a test. */
const LEASE: LeaseConfig = { leaseSeconds: 120, heartbeatSeconds: 30, maxAttempts: 3 };

describe('reliability: lease and reaper (Phase 5 DoD)', () => {
  let db: TestDb;
  let storage: FakeStorage;
  /** Dedicated pool: an advisory lock needs raw clients, not a Drizzle handle. */
  let pool: Pool;

  beforeAll(async () => {
    db = await setupTestDatabase();
    pool = createTestPool(resolveTestDatabaseUrl());
  });

  afterAll(async () => {
    await pool.end();
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
    storage = fakeStorage();
  });

  function deps(
    options: { failStage?: string; stages?: readonly string[]; lease?: LeaseConfig } = {},
  ) {
    const shared = { failStage: options.failStage, sequence: { count: 0 } };
    return {
      db,
      storage,
      providers: {
        text: new MockTextProvider(shared),
        image: new MockImageProvider(shared),
        tts: new MockTtsProvider(shared),
        renderer: new MockRendererProvider(shared),
      },
      stages: options.stages as never,
      lease: options.lease === undefined ? undefined : { workerId: WORKER, config: options.lease },
    };
  }

  const WORKER = workerIdForProcess('test');

  async function newJob(bonus = 50, maxAttempts = 3) {
    const user = await createUserWithBonus(db, { bonus });
    const jobId = await db.transaction(async (tx) => {
      const reservation = await reserve(tx, {
        userId: user.id,
        kind: 'REEL',
        workspaceId: WORKSPACE,
        maxAttempts,
      });
      return reservation.jobId;
    });
    return { userId: user.id, jobId };
  }

  /** A well-formed `job.created` payload for the handler to parse. */
  function eventFor(jobId: string) {
    return {
      eventType: 'job.created',
      jobId,
      userId: '00000000-0000-4000-8000-000000000002',
      workspaceId: WORKSPACE,
      kind: 'REEL',
      creditsReserved: 30,
    };
  }

  async function row(jobId: string) {
    const rows = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    return rows[0];
  }

  async function checkpointsOf(jobId: string): Promise<string[]> {
    const rows = await db
      .select({ stage: jobCheckpoints.stage })
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, jobId))
      .orderBy(jobCheckpoints.createdAt);
    return rows.map((r) => r.stage);
  }

  /**
   * The exact state `kill -9` leaves: PROCESSING, a lease held by a process
   * that will never renew it, and the checkpoints it got as far as writing.
   */
  async function simulateKill(jobId: string, deadWorker: string, expired: boolean): Promise<void> {
    await db
      .update(generationJobs)
      .set({
        status: 'PROCESSING',
        workerId: deadWorker,
        heartbeatAt: new Date(Date.now() - 600_000),
        lockedUntil: expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 60_000),
        attempts: 1,
      })
      .where(eq(generationJobs.id, jobId));
  }

  describe('the lease', () => {
    it('only one of two workers can take a job', async () => {
      const { jobId } = await newJob();

      const first = await acquireLease(db, jobId, 'worker-a', LEASE);
      const second = await acquireLease(db, jobId, 'worker-b', LEASE);

      expect(first?.workerId).toBe('worker-a');
      // Not an error: two workers being handed the same event is normal.
      expect(second).toBeNull();
      expect((await row(jobId))?.workerId).toBe('worker-a');
    });

    it('counts the attempt on the durable row, not on the queue', async () => {
      const { jobId } = await newJob();

      await acquireLease(db, jobId, 'worker-a', LEASE);
      await releaseLease(db, jobId, 'worker-a');
      await acquireLease(db, jobId, 'worker-b', LEASE);

      // BullMQ's attemptsMade lives in Redis and is reset by a Redis restart -
      // the exact event the reaper exists for.
      expect((await row(jobId))?.attempts).toBe(2);
    });

    it('will not renew a lease another worker has taken', async () => {
      const { jobId } = await newJob();
      await acquireLease(db, jobId, 'worker-a', LEASE);
      await db
        .update(generationJobs)
        .set({ workerId: 'worker-b' })
        .where(eq(generationJobs.id, jobId));

      // The zombie case: a worker declared dead, reclaimed, and then waking up.
      // If this succeeded, the zombie and the new owner would both believe they
      // had the job and the reaper could never reclaim it again.
      await expect(renewLease(db, jobId, 'worker-a', LEASE)).resolves.toBe(false);
      expect((await row(jobId))?.workerId).toBe('worker-b');
    });

    it('will not renew or release a job that has already finished', async () => {
      const { jobId } = await newJob();
      await acquireLease(db, jobId, 'worker-a', LEASE);
      await db
        .update(generationJobs)
        .set({ status: 'COMPLETED' })
        .where(eq(generationJobs.id, jobId));

      await expect(renewLease(db, jobId, 'worker-a', LEASE)).resolves.toBe(false);
      expect((await row(jobId))?.workerId).toBe('worker-a');
    });

    it('releases cleanly so shutdown does not wait out the lease', async () => {
      const { jobId } = await newJob();
      await acquireLease(db, jobId, 'worker-a', LEASE);

      await expect(releaseLease(db, jobId, 'worker-a')).resolves.toBe(true);

      const released = await row(jobId);
      expect(released?.workerId).toBeNull();
      expect(released?.lockedUntil).toBeNull();
    });

    it('refuses to release a lease held by somebody else', async () => {
      const { jobId } = await newJob();
      await acquireLease(db, jobId, 'worker-a', LEASE);

      await expect(releaseLease(db, jobId, 'worker-b')).resolves.toBe(false);
      expect((await row(jobId))?.workerId).toBe('worker-a');
    });
  });

  describe('the reaper reclaims a killed worker', () => {
    it('re-queues a job whose lease expired with attempts left', async () => {
      const { jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);

      const result = await sweepOnce(db);

      expect(result.requeued).toEqual([jobId]);
      const recovered = await row(jobId);
      expect(recovered).toMatchObject({ status: 'PENDING', workerId: null, lockedUntil: null });
      // Attempts are NOT reset: the job really did fail once, and a reaper that
      // forgot that would give every job infinite retries.
      expect(recovered?.attempts).toBe(1);
    });

    it('leaves a job alone while its lease is still valid', async () => {
      const { jobId } = await newJob();
      await simulateKill(jobId, 'busy-but-alive-worker', false);

      const result = await sweepOnce(db);

      // Not expired: the worker is merely slow. Stealing its job here is how two
      // workers render the same reel and race to capture the credits.
      expect(result).toMatchObject({ requeued: [], failed: [] });
      expect((await row(jobId))?.workerId).toBe('busy-but-alive-worker');
    });

    it('refunds exactly once when attempts are exhausted', async () => {
      const { userId, jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);
      await db.update(generationJobs).set({ attempts: 3 }).where(eq(generationJobs.id, jobId));

      const result = await sweepOnce(db);

      expect(result.failed).toEqual([jobId]);
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });

      const refunds = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'REFUND'`);
      expect(refunds).toHaveLength(1);
    });

    it('produces one refund when the reaper runs repeatedly', async () => {
      const { userId, jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);
      await db.update(generationJobs).set({ attempts: 9 }).where(eq(generationJobs.id, jobId));

      await sweepOnce(db);
      await sweepOnce(db);
      await sweepOnce(db);

      // C8: the refund is claimed with a guarded UPDATE, so however many sweeps
      // run, the credits move once.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
      const refunds = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'REFUND'`);
      expect(refunds).toHaveLength(1);
    });

    it('never touches a job it already gave up on', async () => {
      const { jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);
      await db.update(generationJobs).set({ attempts: 9 }).where(eq(generationJobs.id, jobId));

      await sweepOnce(db);
      const second = await sweepOnce(db);

      // FAILED is not in the sweep's WHERE clause, so it cannot be re-enqueued
      // and run for free after the credits went back to the user.
      expect(second).toMatchObject({ requeued: [], failed: [] });
      expect((await row(jobId))?.status).toBe('FAILED');
    });

    it('emits a re-enqueue event the relay can publish', async () => {
      const { jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);

      await sweepOnce(db);

      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, jobId));
      // The requeue has its own dedupe key. Reusing the original create key
      // would collide with it and the job would never be published again - a
      // reaper that looks like it worked and strands the job.
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
    });

    it('replays a complete job.created payload a worker can actually run', async () => {
      const { userId, jobId } = await newJob();
      await simulateKill(jobId, 'dead-worker', true);

      await sweepOnce(db);

      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, jobId));
      const requeued = events.find((event) => event.dedupeKey.includes(':job.requeued:'));
      expect(requeued).toBeDefined();

      // The bug this guards against: the requeue used to carry only
      // `{eventType, jobId, reason}`. The relay published it happily, and every
      // worker then rejected it with a zod error, leaving the job PENDING with
      // its credits reserved. Parsing the stored payload is the same check the
      // worker performs at the process boundary.
      const payload = jobCreatedEventSchema.parse(requeued?.payload);
      expect(payload).toMatchObject({
        eventType: 'job.created',
        jobId,
        userId,
        workspaceId: WORKSPACE,
        kind: 'REEL',
        creditsReserved: 30,
      });

      // And it must be enough to finish the job, not merely enough to parse.
      await handleGenerationJob(deps({ lease: LEASE }), {
        data: requeued?.payload,
        attemptsMade: 0,
        attempts: 3,
      });

      expect((await row(jobId))?.status).toBe('COMPLETED');
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 0 });
      const captures = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'CAPTURE'`);
      expect(captures).toHaveLength(1);
    });

    it('re-queues a job that was never started at all', async () => {
      const { jobId } = await newJob();

      const result = await sweepOnce(db);

      // attempts === 0 means the event was never delivered, not that the job
      // failed. It has no attempt budget to exhaust.
      expect(result.requeued).toEqual([jobId]);
      expect((await row(jobId))?.status).toBe('PENDING');
    });

    it('finds a PENDING job the relay never published', async () => {
      const { jobId } = await newJob();
      await db.execute(sql`
        UPDATE generation_jobs
           SET created_at = now() - make_interval(secs => 600),
               status = 'PENDING',
               attempts = 0,
               worker_id = NULL,
               locked_until = NULL
         WHERE id = ${jobId}::uuid
      `);

      const result = await sweepOrphanedPending(db, 120);

      expect(result.requeued).toEqual([jobId]);
    });

    it('leaves a young PENDING job alone', async () => {
      const { jobId } = await newJob();

      // Redis may simply not have published it yet. Re-queueing immediately
      // would duplicate every job during a slow start.
      const result = await sweepOrphanedPending(db, 120);

      expect(result.requeued).toEqual([]);
      expect((await row(jobId))?.status).toBe('PENDING');
    });
  });

  describe('R1: killed at IMAGE, another worker resumes from checkpoint', () => {
    it('does not redo the stages that already finished', async () => {
      const { userId, jobId } = await newJob();

      // content-worker finishes PLAN and SCRIPT, then dies before IMAGE.
      await processJob(deps({ stages: [...CONTENT_STAGES], lease: LEASE }), jobId);
      expect(await checkpointsOf(jobId)).toEqual(['PLAN', 'SCRIPT']);

      await simulateKill(jobId, 'dead-media-worker', true);
      const result = await sweepOnce(db);
      expect(result.requeued).toEqual([jobId]);

      // A different worker picks it up. Acquiring the lease and running are one
      // operation in reality; taking the lease by hand and then running as
      // somebody else is a setup the guard correctly refuses, which is itself
      // worth knowing.
      const resumed = await processJob(deps({ stages: [...MEDIA_STAGES], lease: LEASE }), jobId);

      // Second attempt on the durable row: the reaper did not reset it, and the
      // new worker's claim counted.
      expect((await row(jobId))?.attempts).toBe(2);

      expect(resumed.outcome).toBe('COMPLETED');
      expect(resumed.stagesRun).toEqual(['IMAGE', 'VOICE', 'RENDER']);
      expect(await checkpointsOf(jobId)).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
      // The user paid once, at the end, not once per worker that touched it.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 0 });

      const captures = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'CAPTURE'`);
      expect(captures).toHaveLength(1);
    });

    it('hands the credits back once the retries run out mid-render', async () => {
      const { userId, jobId } = await newJob();
      await processJob(deps({ stages: [...CONTENT_STAGES], lease: LEASE }), jobId);

      // Three workers each die at IMAGE. The third exhausts the budget.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await simulateKill(jobId, `dead-${attempt}`, true);
        await db
          .update(generationJobs)
          .set({ attempts: attempt + 1 })
          .where(eq(generationJobs.id, jobId));
        await sweepOnce(db);
      }

      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
      expect((await row(jobId))?.status).toBe('FAILED');

      const refunds = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'REFUND'`);
      expect(refunds).toHaveLength(1);
    });
  });

  describe('a worker holding a lease decides refunds from the durable counter', () => {
    it('does not refund while the durable budget remains', async () => {
      const { userId, jobId } = await newJob();

      // BullMQ's counter is 0: it has just handed the job over. The row says
      // 1 of 3 because the worker took the lease, and the row is what decides.
      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE', lease: LEASE }), {
          data: eventFor(jobId),
          attemptsMade: 0,
          attempts: 3,
        }),
      ).rejects.toThrow();

      expect((await row(jobId))?.attempts).toBe(1);
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 30 });
    });

    it('refunds on the failure that spends the last attempt', async () => {
      const { userId, jobId } = await newJob();
      // Two attempts already used. Taking the lease makes this the third, and
      // the third is the last.
      await db.update(generationJobs).set({ attempts: 2 }).where(eq(generationJobs.id, jobId));

      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE', lease: LEASE }), {
          data: eventFor(jobId),
          attemptsMade: 0,
          attempts: 3,
        }),
      ).rejects.toThrow();

      expect((await row(jobId))?.attempts).toBe(3);
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
    });

    it('trusts the row over the queue when they disagree', async () => {
      const { userId, jobId } = await newJob();
      await db.update(generationJobs).set({ attempts: 3 }).where(eq(generationJobs.id, jobId));

      // attemptsMade is 0: the queue believes this is the first try. The row
      // knows the budget is gone, and the row is the one that survives the Redis
      // restart this mechanism exists for - so it wins.
      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE', lease: LEASE }), {
          data: eventFor(jobId),
          attemptsMade: 0,
          attempts: 3,
        }),
      ).rejects.toThrow();

      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
    });

    it('releases the lease when a job fails', async () => {
      const { jobId } = await newJob();

      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE', lease: LEASE }), {
          data: eventFor(jobId),
          attemptsMade: 0,
          attempts: 3,
        }),
      ).rejects.toThrow();

      // Left held, the reaper would wait out a whole lease period before anyone
      // could retry - turning one failure into two minutes of downtime.
      const released = await row(jobId);
      expect(released?.workerId).toBeNull();
      expect(released?.lockedUntil).toBeNull();
    });
  });

  describe('the reaper runs under a single-instance lock', () => {
    it('lets exactly one holder through', async () => {
      const key = 0x5_111_111;

      // Two acquisitions on two separate connections: the second must be told
      // it lost, or both reapers sweep and every answer to "who is doing the
      // work" is "both of them".
      const first = await tryAcquireAdvisoryLock(pool, key);
      const second = await tryAcquireAdvisoryLock(pool, key);

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);

      await first.release();
    });

    it('lets the next process in once released', async () => {
      const key = 0x5_222_222;

      const first = await tryAcquireAdvisoryLock(pool, key);
      await first.release();

      const second = await tryAcquireAdvisoryLock(pool, key);
      expect(second.acquired).toBe(true);
      await second.release();
    });

    it('releases cleanly even if nothing was held', async () => {
      const lock = await tryAcquireAdvisoryLock(pool, 0x5_333_333);
      await expect(lock.release()).resolves.toBeUndefined();
    });
  });

  describe('abandoned outbox events', () => {
    it('surfaces events the relay gave up on rather than deleting them', async () => {
      const { jobId } = await newJob();
      await db
        .update(outboxEvents)
        .set({ attempts: 10 })
        .where(eq(outboxEvents.aggregateId, jobId));

      const abandoned = await findAbandonedOutbox(db, 10);

      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]).toMatchObject({ eventType: 'job.created', aggregateId: jobId });
    });

    it('replays one back into the pending set', async () => {
      const { jobId } = await newJob();
      await db
        .update(outboxEvents)
        .set({ attempts: 10 })
        .where(eq(outboxEvents.aggregateId, jobId));
      const [event] = await findAbandonedOutbox(db, 10);

      await expect(replayOutboxEvent(db, event?.id as string)).resolves.toBe(true);

      // The attempt counter resets with the event. Leaving it at the limit would
      // mean the relay never picks it up again - a replay that looked successful
      // and delivered nothing.
      expect(await findAbandonedOutbox(db, 10)).toHaveLength(0);
    });

    it('reports nothing to replay for an unknown id', async () => {
      await expect(replayOutboxEvent(db, '00000000-0000-4000-8000-000000000000')).resolves.toBe(
        false,
      );
    });
  });
});
