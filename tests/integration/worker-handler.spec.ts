import { eq } from 'drizzle-orm';

import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  ProviderError,
} from '@renderflow/ai';
import { generationJobs } from '@renderflow/db';
import { handleGenerationJob } from '@renderflow/jobs';
import { reserve } from '@renderflow/credits';

import { createUserWithBonus, walletOf } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import { fakeStorage } from './helpers/fake-storage';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * The worker handler's retry and refund policy, against a real database.
 *
 * `isFinalAttempt` is unit-tested in `libs/jobs`, but the arithmetic alone is not
 * the policy. What matters is the combination with the credit engine, and the two
 * ways it can be wrong are both invisible in a happy path:
 *
 *  - Refund too early and the user pays nothing for a generation that succeeded
 *    on the retry.
 *  - Never refund and a reservation stays pinned to the user's balance forever,
 *    because nothing else in the system knows the job is dead.
 *
 * The handler rethrows either way, because BullMQ owns the retry and needs to
 * see the failure to move the job to the DLQ.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe('worker handler: retry and refund (Phase 4)', () => {
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

  function event(jobId: string) {
    return {
      eventType: 'job.created' as const,
      jobId,
      userId: '00000000-0000-4000-8000-000000000002',
      workspaceId: WORKSPACE,
      kind: 'REEL' as const,
      creditsReserved: 30,
    };
  }

  async function newJob(bonus = 50): Promise<{ userId: string; jobId: string }> {
    const user = await createUserWithBonus(db, { bonus });
    const jobId = await db.transaction(async (tx) => {
      const reservation = await reserve(tx, {
        userId: user.id,
        kind: 'REEL',
        workspaceId: WORKSPACE,
      });
      return reservation.jobId;
    });
    return { userId: user.id, jobId };
  }

  function deps(options: { failStage?: string; failEveryNth?: number } = {}) {
    const shared = {
      failStage: options.failStage,
      failEveryNth: options.failEveryNth,
      sequence: { count: 0 },
    };
    return {
      db,
      storage: fakeStorage(),
      providers: {
        text: new MockTextProvider(shared),
        image: new MockImageProvider(shared),
        tts: new MockTtsProvider(shared),
        renderer: new MockRendererProvider(shared),
      },
      defaultAttempts: 3,
    };
  }

  const job = (jobId: string, attemptsMade: number, attempts = 3) => ({
    data: event(jobId),
    attemptsMade,
    attempts,
  });

  describe('a transient failure', () => {
    it('does not refund on an early attempt, so the retry can still succeed', async () => {
      const { userId, jobId } = await newJob();

      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE' }), job(jobId, 0, 3)),
      ).rejects.toThrow();

      // Still reserved, not refunded: the user has not been charged for a job
      // that has not finished, and the credits are still available to retry with.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 30 });
    });

    it('refunds once, on the final attempt', async () => {
      const { userId, jobId } = await newJob();

      // attemptsMade 2 is the third and last of three.
      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE' }), job(jobId, 2, 3)),
      ).rejects.toThrow();

      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });

      const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      expect(row).toMatchObject({ status: 'FAILED', refunded: 1, captured: 0 });
    });

    it('rethrows on the final attempt so the job reaches the DLQ', async () => {
      const { jobId } = await newJob();

      // A handler that swallowed the error here would mark a failed generation
      // as succeeded, and the job would sit in BullMQ's completed set forever.
      await expect(
        handleGenerationJob(deps({ failStage: 'IMAGE' }), job(jobId, 2, 3)),
      ).rejects.toThrow(/IMAGE/);
    });

    it('succeeds on a retry after an early failure, and charges once', async () => {
      const { userId, jobId } = await newJob();

      // First attempt fails on the first IMAGE call.
      await expect(
        handleGenerationJob(deps({ failEveryNth: 1 }), job(jobId, 0, 3)),
      ).rejects.toThrow();

      // Second attempt: the sequence is fresh, so IMAGE succeeds this time.
      const ok = await handleGenerationJob(deps(), job(jobId, 1, 3));
      expect(ok).toBeUndefined();

      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 0 });
    });

    it('is a no-op when the job has already been settled', async () => {
      const { userId, jobId } = await newJob();

      await handleGenerationJob(deps(), job(jobId, 0, 3));
      // A duplicate delivery of the same event must not charge twice or rerun.
      await handleGenerationJob(deps(), job(jobId, 1, 3));

      await expect(walletOf(db, userId)).resolves.toEqual({ available: 20, reserved: 0 });
    });
  });

  describe('a permanent failure', () => {
    it('refunds immediately rather than burning two more attempts', async () => {
      const { userId, jobId } = await newJob();

      const providers = {
        text: new MockTextProvider({}),
        image: new MockImageProvider({}),
        tts: new MockTtsProvider({}),
        renderer: new MockRendererProvider({}),
      };
      // A refusal that will not change on a retry: retrying only delays the
      // refund by two backoff intervals for nothing.
      providers.image.generate = async () => {
        throw new ProviderError('nsfw', 'PERMANENT');
      };

      // Rethrown raw, not wrapped: BullMQ sees the provider's own error, and
      // `describeError` is what adds the classification on the way to the API.
      await expect(handleGenerationJob({ ...deps(), providers }, job(jobId, 0, 3))).rejects.toThrow(
        /nsfw/,
      );

      // First attempt of three, and the credits are already back.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
    });
  });

  describe('payload validation', () => {
    it('refuses a malformed event before touching the database', async () => {
      const { jobId } = await newJob();

      await expect(
        handleGenerationJob(deps(), {
          data: { ...event(jobId), jobId: 'not-a-uuid' },
          attemptsMade: 0,
          attempts: 3,
        }),
      ).rejects.toThrow();

      // No refund and no failure recorded: a message we cannot parse says
      // nothing about the job, and guessing would be worse than refusing.
      const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      expect(row).toMatchObject({ status: 'PENDING', refunded: 0 });
    });

    it('records the failure reason on the job for the API to show', async () => {
      const { jobId } = await newJob();

      await expect(
        handleGenerationJob(deps({ failStage: 'RENDER' }), job(jobId, 2, 3)),
      ).rejects.toThrow();

      const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      // No prompt text, no provider internals - this string is returned by
      // GET /jobs/:id, so it has to be safe to show a user.
      expect(String(row?.error)).toMatch(/RENDER/);
      expect(String(row?.error).length).toBeLessThanOrEqual(500);
    });
  });
});
