import { eq, sql } from 'drizzle-orm';

import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
} from '@renderflow/ai';
import { getBalance, reconcileUser, reserve } from '@renderflow/credits';
import { describeError, failJob, processJob, runJob } from '@renderflow/jobs';
import { creditLedger, generationJobs, jobCheckpoints, pricingRules } from '@renderflow/db';

import { createUserWithBonus, walletOf } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';
import { fakeStorage, type FakeStorage } from './helpers/fake-storage';

/**
 * The job runner (PROJECT.md section 12 Phase 4 DoD: "creating a reel job reserves
 * 30, progresses through all stages visible via SSE, ends with capture; forced
 * failure ends with refund").
 *
 * Runs against a real Postgres and a real storage double, with mock AI providers
 * (AGENTS.md section 8). SSE itself is exercised in the API suite; what is proved
 * here is everything behind it: the checkpoints, the resume behaviour, and -
 * most importantly - that the user's credits end up in exactly one of the two
 * correct states.
 */
describe('job runner (Phase 4 DoD)', () => {
  let db: TestDb;
  let storage: FakeStorage;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
    storage = fakeStorage();
  });

  function deps(options: { failStage?: string; failEveryNth?: number } = {}) {
    const shared = {
      failStage: options.failStage,
      failEveryNth: options.failEveryNth,
      sequence: { count: 0 },
    };
    return {
      db,
      storage,
      providers: {
        text: new MockTextProvider(shared),
        image: new MockImageProvider(shared),
        tts: new MockTtsProvider(shared),
        renderer: new MockRendererProvider(shared),
      },
      brand: {
        name: 'Northwind',
        tone: 'friendly',
        audience: 'commuters',
        colors: ['#112233'],
        languages: ['en'],
      },
    };
  }

  /** Reserves a job the way the API would, so credits are real. */
  async function createJob(
    userId: string,
    kind: 'REEL' | 'POSTER' | 'CAPTION',
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    return db.transaction(async (tx) => {
      const reservation = await reserve(tx, { userId, kind, payload });
      return reservation.jobId;
    });
  }

  async function checkpointsOf(jobId: string): Promise<string[]> {
    const rows = await db
      .select({ stage: jobCheckpoints.stage })
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, jobId))
      .orderBy(jobCheckpoints.createdAt);
    return rows.map((r) => r.stage);
  }

  async function jobRow(jobId: string) {
    const rows = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, jobId))
      .limit(1);
    return rows[0];
  }

  describe('C3/C6: a reel runs every stage and captures', () => {
    it('reserves 30, checkpoints all five stages, and captures', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });

      const jobId = await createJob(user.id, 'REEL', { scenes: 3, images: 3 });

      // Reserved before any work: available 20, reserved 30.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 30 });

      const result = await runJob(deps(), jobId);

      expect(result.outcome).toBe('COMPLETED');
      expect(result.stagesRun).toEqual(['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
      await expect(checkpointsOf(jobId)).resolves.toEqual([
        'PLAN',
        'SCRIPT',
        'IMAGE',
        'VOICE',
        'RENDER',
      ]);

      // PROJECT.md section 5.7: reserved 0, available stays at 20 - the user paid.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });

      const entries = await db
        .select({ entryType: creditLedger.entryType, amount: creditLedger.amount })
        .from(creditLedger)
        .where(eq(creditLedger.userId, user.id));
      expect(entries.filter((e) => e.entryType === 'CAPTURE')).toHaveLength(1);
      expect(entries.filter((e) => e.entryType === 'REFUND')).toHaveLength(0);

      await expect(jobRow(jobId)).resolves.toMatchObject({ status: 'COMPLETED', stage: 'DONE' });
    });

    it('writes an artefact to storage for every stage it runs', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL', { scenes: 2, images: 2 });

      await runJob(deps(), jobId);

      // A checkpoint that references a missing object would make `confirm` fail
      // later, so the runner writes the bytes before the checkpoint.
      expect(storage.objects.size).toBeGreaterThanOrEqual(5);
      for (const [key, value] of storage.objects) {
        expect(value.contentType).toEqual(expect.any(String));
        expect(key).toEqual(expect.any(String));
      }
    });

    it('leaves the wallet reconcilable afterwards', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await runJob(deps(), jobId);

      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
    });
  });

  describe('C7: a forced failure refunds', () => {
    it('refunds every credit when IMAGE fails', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      const result = await processJob(deps({ failStage: 'IMAGE' }), jobId);

      expect(result.outcome).toBe('FAILED');
      // Back to the full 50: the user pays nothing for work that never finished.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });

      const entries = await db
        .select({ entryType: creditLedger.entryType })
        .from(creditLedger)
        .where(eq(creditLedger.userId, user.id));
      expect(entries.filter((e) => e.entryType === 'REFUND')).toHaveLength(1);
      expect(entries.filter((e) => e.entryType === 'CAPTURE')).toHaveLength(0);

      await expect(jobRow(jobId)).resolves.toMatchObject({ status: 'FAILED', refunded: 1 });
    });

    it('keeps the checkpoints it did complete, and stops at the failure', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await processJob(deps({ failStage: 'IMAGE' }), jobId);

      // PLAN and SCRIPT succeeded and are recorded; IMAGE onwards never ran.
      await expect(checkpointsOf(jobId)).resolves.toEqual(['PLAN', 'SCRIPT']);
    });

    it('refuses to capture a job whose work failed', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await processJob(deps({ failStage: 'RENDER' }), jobId);

      // Even though four of five stages succeeded, a job that did not finish is
      // not charged.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });
      expect((await checkpointsOf(jobId)).length).toBe(4);
    });
  });

  describe('C8: settling twice is a no-op', () => {
    it('capturing an already-captured job changes nothing', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await runJob(deps(), jobId);
      const second = await runJob(deps(), jobId);

      expect(second.outcome).toBe('ALREADY_SETTLED');
      expect(second.stagesRun).toEqual([]);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });

      const captures = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(sql`${creditLedger.entryType} = 'CAPTURE'`);
      expect(captures).toHaveLength(1);
    });

    it('refunding an already-refunded job changes nothing', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await failJob(db, jobId, 'first');
      const second = await failJob(db, jobId, 'second');

      expect(second).toEqual({ refunded: false, amount: 0 });
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });
    });

    it('will not run a job whose credits were already refunded', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await failJob(db, jobId, 'user cancelled');

      const result = await runJob(deps(), jobId);

      // Producing media for free after a refund would be a hole in the billing.
      expect(result.outcome).toBe('ALREADY_SETTLED');
      await expect(checkpointsOf(jobId)).resolves.toEqual([]);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });
    });

    it('will not refund a job that was captured', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await runJob(deps(), jobId);
      const result = await failJob(db, jobId, 'late reaper');

      // C9: the user already paid. Refunding would mint credits from nothing.
      expect(result.refunded).toBe(false);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
    });
  });

  describe('resume from checkpoints', () => {
    it('skips stages already checkpointed', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL', { scenes: 2, images: 2 });

      // A worker that died after IMAGE leaves those checkpoints behind.
      await db.insert(jobCheckpoints).values([
        { jobId, stage: 'PLAN', outputRef: 'a' },
        { jobId, stage: 'SCRIPT', outputRef: 'b' },
        { jobId, stage: 'IMAGE', outputRef: 'c' },
      ]);

      const result = await runJob(deps(), jobId);

      expect(result.stagesRun).toEqual(['VOICE', 'RENDER']);
      expect(result.outcome).toBe('COMPLETED');
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
    });

    it('settles a fully checkpointed job without redoing any work', async () => {
      // A crash between the last checkpoint and the capture: every stage is
      // checkpointed and the credits are still reserved.
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      await db.insert(jobCheckpoints).values(
        ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER'].map((stage) => ({
          jobId,
          stage: stage as 'PLAN',
          outputRef: `ref/${stage}`,
        })),
      );

      const result = await runJob(deps(), jobId);

      expect(result.outcome).toBe('COMPLETED');
      expect(result.stagesRun).toEqual([]);
      // Nothing was re-generated, so nothing was re-paid.
      expect(storage.objects.size).toBe(0);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
    });

    it('does not resume past a gap', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      // SCRIPT is missing even though IMAGE exists: a later artefact may depend
      // on it, so everything from SCRIPT onwards is redone.
      await db.insert(jobCheckpoints).values([
        { jobId, stage: 'PLAN', outputRef: 'a' },
        { jobId, stage: 'IMAGE', outputRef: 'c' },
      ]);

      const result = await runJob(deps(), jobId);

      expect(result.stagesRun).toEqual(['SCRIPT', 'IMAGE', 'VOICE', 'RENDER']);
    });
  });

  describe('single-stage kinds', () => {
    it('runs only IMAGE for a poster', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'POSTER');

      const result = await runJob(deps(), jobId);

      expect(result.stagesRun).toEqual(['IMAGE']);
      await expect(checkpointsOf(jobId)).resolves.toEqual(['IMAGE']);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 45, reserved: 0 });
    });

    it('runs only SCRIPT for a caption', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'CAPTION');

      const result = await runJob(deps(), jobId);

      expect(result.stagesRun).toEqual(['SCRIPT']);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 49, reserved: 0 });
    });
  });

  describe('deterministic failure injection', () => {
    it('fails on a chosen attempt and succeeds on the next', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      const jobId = await createJob(user.id, 'REEL');

      // First IMAGE call fails, the second succeeds.
      const failing = await processJob(deps({ failEveryNth: 1 }), jobId);
      expect(failing.outcome).toBe('FAILED');

      const retry = await createJob(user.id, 'REEL');
      const ok = await processJob(deps(), retry);
      expect(ok.outcome).toBe('COMPLETED');
    });
  });

  describe('unknown jobs', () => {
    it('throws rather than silently succeeding', async () => {
      await expect(runJob(deps(), '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('describeError', () => {
    it('keeps a provider classification visible', () => {
      // The API returns this text, so the classification has to survive.
      expect(describeError(new Error('boom'))).toBe('boom');
      expect(
        describeError(
          Object.assign(new Error('rate limited'), {
            name: 'ProviderError',
          }),
        ),
      ).toEqual(expect.stringContaining('rate limited'));
    });

    it('summarises a non-Error without stringifying an object', () => {
      expect(describeError({ secret: 'token' })).toBe('unknown error');
      expect(describeError(null)).toBe('unknown error');
    });

    it('truncates a long message so it cannot blow up the column', () => {
      const long = new Error('x'.repeat(2_000));
      expect(describeError(long)).toHaveLength(500);
    });
  });

  describe('pricing', () => {
    it('charges the server-side price for each kind', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });

      await runJob(deps(), await createJob(user.id, 'REEL'));
      await runJob(deps(), await createJob(user.id, 'POSTER'));

      const balance = await getBalance(db, user.id);
      // 50 - 30 (reel) - 5 (poster) = 15
      expect(balance).toEqual({ userId: user.id, available: 15, reserved: 0, total: 15 });
    });

    it('uses the price table rather than a literal', async () => {
      await db.update(pricingRules).set({ credits: 7 }).where(eq(pricingRules.action, 'REEL'));
      const user = await createUserWithBonus(db, { bonus: 50 });

      const jobId = await createJob(user.id, 'REEL');
      await runJob(deps(), jobId);

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 43, reserved: 0 });
    });
  });
});
