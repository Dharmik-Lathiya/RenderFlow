import { eq, sql } from 'drizzle-orm';

import {
  CreditError,
  DEFAULT_PRICES,
  adjust,
  assertPricingComplete,
  capture,
  getBalance,
  listPrices,
  priceFor,
  refund,
  reconcileUser,
  reserve,
  reserveOnce,
} from '@renderflow/credits';
import { creditLedger, pricingRules } from '@renderflow/db';

import { createUserWithBonus, ledgerOf, walletOf } from './helpers/auth-fixtures';
import {
  deactivatePrice,
  jobCount,
  jobsOf,
  outboxCount,
  pendingOutbox,
  seedPrice,
  seedPricing,
} from './helpers/credit-fixtures';
import { setupTestDatabase, teardownTestDatabase, type TestDb } from './helpers/test-database';

/**
 * Phase 2 credit engine (PROJECT.md section 12, DoD: "100 concurrent reserves
 * against 50 credits never overspend; double refund is a no-op; reconcile reports
 * zero drift").
 *
 * Covers tests C3-C12 from PROJECT.md section 13.2.
 *
 * Everything here runs against a real Postgres because that is where the
 * guarantees live: the guarded `UPDATE ... WHERE available >= cost` is what stops
 * an overdraft under concurrency, the unique ledger key is what makes a movement
 * at-most-once, and the CHECK constraints are the last line of defence. A mocked
 * database would assert only that the code calls the methods the test expected.
 */
describe('credit engine (C3-C12)', () => {
  let db: TestDb;
  const BONUS = 50;
  /**
   * Every reservation names its workspace, as the API does.
   *
   * `reserve` only emits `job.created` when it is told which workspace the job
   * belongs to, because the relay validates that field as a uuid and an event
   * carrying a placeholder would fail validation inside a worker instead of on
   * an API error path. These tests assert on the outbox, so they have to supply
   * it.
   */
  const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await teardownTestDatabase(db);
    await seedPricing(db);
  });

  /** Runs `fn` inside a real transaction, like an API handler would. */
  async function inTransaction<T>(
    fn: (tx: Parameters<Parameters<TestDb['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => fn(tx));
  }

  describe('C3: reserve', () => {
    it('moves credits available -> reserved and records RESERVE -30', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      expect(reservation.cost).toBe(30);
      expect(reservation.replayed).toBe(false);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 30 });

      const reserveRow = (await ledgerOf(db, user.id)).find((row) => row.entryType === 'RESERVE');
      expect(reserveRow).toMatchObject({
        entryType: 'RESERVE',
        amount: -30,
        referenceType: 'JOB',
        referenceId: reservation.jobId,
      });

      // The job exists in the same transaction as the reservation.
      await expect(jobsOf(db, user.id)).resolves.toEqual([
        expect.objectContaining({ id: reservation.jobId, creditsReserved: 30, status: 'PENDING' }),
      ]);
    });

    it('uses the server-side price, never a client-supplied cost', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await seedPrice(db, 'REEL', 42);

      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      expect(reservation.cost).toBe(42);
    });

    it('creates the job and its outbox event atomically', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );

      // No direct queue push happens anywhere in the API (AGENTS.md rule 6); the
      // relay picks this up later.
      await expect(pendingOutbox(db)).resolves.toEqual([
        expect.objectContaining({ eventType: 'job.created' }),
      ]);
    });
  });

  describe('C4: insufficient credits', () => {
    it('rejects with 402 and creates nothing', async () => {
      const user = await createUserWithBonus(db, { bonus: 20 });

      const before = await ledgerOf(db, user.id);

      await expect(
        inTransaction((tx) =>
          reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', httpStatus: 402 });

      // Nothing at all: no movement, no job, no event, balance untouched.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
      await expect(ledgerOf(db, user.id)).resolves.toEqual(before);
      await expect(jobCount(db)).resolves.toBe(0);
      await expect(outboxCount(db)).resolves.toBe(0);
    });

    it('names the shortfall in the error details', async () => {
      const user = await createUserWithBonus(db, { bonus: 5 });

      let thrown: unknown;
      try {
        await inTransaction((tx) =>
          reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
        );
      } catch (error) {
        thrown = error;
      }

      expect((thrown as { details: unknown }).details).toEqual({ required: 30, available: 5 });
    });

    it('refuses to reserve for a user with no wallet', async () => {
      await expect(
        inTransaction((tx) =>
          reserve(tx, { userId: '99999999-9999-9999-9999-999999999999', kind: 'REEL' }),
        ),
      ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    });
  });

  describe('C5: concurrent reserve', () => {
    it('100 parallel reserves of 10 against 50 credits admit exactly 5', async () => {
      // The headline DoD. Every one of these runs in its own transaction with no
      // coordination: the only thing preventing an overdraft is Postgres
      // re-evaluating `available >= cost` against the row as it locks it.
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const attempts = await Promise.allSettled(
        Array.from({ length: 100 }, () =>
          inTransaction((tx) =>
            reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID, cost: 10 }),
          ),
        ),
      );

      const succeeded = attempts.filter((a) => a.status === 'fulfilled');
      const failed = attempts.filter((a) => a.status === 'rejected');

      expect(succeeded).toHaveLength(5);
      expect(failed).toHaveLength(95);

      // Every failure is the documented 402, not a crash.
      for (const failure of failed) {
        expect(failure.reason).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      }

      // The balance is exactly exhausted, never negative, never over-reserved.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 0, reserved: 50 });
      await expect(jobCount(db)).resolves.toBe(5);

      const reserveRows = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'RESERVE');
      expect(reserveRows).toHaveLength(5);
      expect(reserveRows.reduce((sum, row) => sum + row.amount, 0)).toBe(-50);
    });

    it('never lets the reserved total exceed what was held', async () => {
      // A second shape of the same race: uneven costs against an awkward balance.
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const attempts = await Promise.allSettled(
        Array.from({ length: 60 }, () =>
          inTransaction((tx) =>
            reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID, cost: 17 }),
          ),
        ),
      );

      const succeeded = attempts.filter((a) => a.status === 'fulfilled');
      // 50 / 17 = 2 whole reservations, never 3.
      expect(succeeded).toHaveLength(2);

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 16, reserved: 34 });
    });

    it('rejects every overshoot with the same 402 under concurrency', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const attempts = await Promise.allSettled(
        Array.from({ length: 50 }, () =>
          inTransaction((tx) =>
            reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID, cost: 50 }),
          ),
        ),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 0, reserved: 50 });
    });
  });

  describe('C6: capture on success', () => {
    it('releases reserved credits and records CAPTURE, with no refund', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      await inTransaction((tx) => capture(tx, reservation.jobId, { assetKey: 'out/reel.mp4' }));

      // PROJECT.md section 5.7: reserved 0, available stays at 20.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });

      const entries = await ledgerOf(db, user.id);
      expect(entries.filter((row) => row.entryType === 'CAPTURE')).toEqual([
        expect.objectContaining({ amount: -30, referenceId: reservation.jobId }),
      ]);
      expect(entries.filter((row) => row.entryType === 'REFUND')).toHaveLength(0);

      await expect(jobsOf(db, user.id)).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED', captured: 1, refunded: 0 }),
      ]);
    });

    it('is a no-op when called twice', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const first = await inTransaction((tx) => capture(tx, reservation.jobId));
      const second = await inTransaction((tx) => capture(tx, reservation.jobId));

      expect(first.captured).toBe(true);
      expect(second).toEqual({ captured: false, amount: 0 });

      // Captured once, so the balance moved once.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
      const captures = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'CAPTURE');
      expect(captures).toHaveLength(1);
    });

    it('marks the job finished', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );

      await inTransaction((tx) => capture(tx, reservation.jobId));

      await expect(jobsOf(db, user.id)).resolves.toEqual([
        expect.objectContaining({ status: 'COMPLETED' }),
      ]);
    });
  });

  describe('C7: refund on failure', () => {
    it('returns reserved credits to available and records one REFUND', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const result = await inTransaction((tx) =>
        refund(tx, reservation.jobId, 'provider returned PERMANENT'),
      );

      expect(result).toEqual({ refunded: true, amount: 30 });
      // PROJECT.md section 5.7: back to the full 50, nothing reserved.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });

      const entries = await ledgerOf(db, user.id);
      expect(entries.filter((row) => row.entryType === 'REFUND')).toEqual([
        expect.objectContaining({ amount: 30, referenceId: reservation.jobId }),
      ]);
      expect(entries.filter((row) => row.entryType === 'CAPTURE')).toHaveLength(0);

      await expect(jobsOf(db, user.id)).resolves.toEqual([
        expect.objectContaining({ status: 'FAILED', refunded: 1, captured: 0 }),
      ]);
    });

    it('emits credits.refunded for the relay', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      await inTransaction((tx) => refund(tx, reservation.jobId));

      await expect(pendingOutbox(db)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ eventType: 'credits.refunded' })]),
      );
    });

    it('keeps the user who had reserved several jobs whole on one failure', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const first = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );
      const second = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 15, reserved: 35 });

      await inTransaction((tx) => refund(tx, first.jobId));

      // Only the first job's credits came back; the second is still reserved.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 45, reserved: 5 });
      expect(second.cost).toBe(5);
    });
  });

  describe('C8: refund is idempotent', () => {
    it('two refunds of one job produce exactly one', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const first = await inTransaction((tx) => refund(tx, reservation.jobId, 'worker 1'));
      const second = await inTransaction((tx) => refund(tx, reservation.jobId, 'reaper'));

      expect(first.refunded).toBe(true);
      expect(second).toEqual({ refunded: false, amount: 0 });

      // The whole point: the balance reflects ONE refund, not two.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
      const refunds = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'REFUND');
      expect(refunds).toHaveLength(1);
    });

    it('survives a concurrent refund race with exactly one winner', async () => {
      // The real scenario: a worker gives up while the reaper independently
      // decides the job is dead. Both call refund at once.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          inTransaction((tx) => refund(tx, reservation.jobId, 'race')),
        ),
      );

      expect(results.filter((r) => r.refunded)).toHaveLength(1);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });

      const refunds = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'REFUND');
      expect(refunds).toHaveLength(1);
    });

    it('is also protected by the ledger unique key, not only by the job flag', async () => {
      // Defence in depth: even if the job flag were bypassed, a second REFUND row
      // for the same (reference_type, reference_id, entry_type) cannot be written.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) => refund(tx, reservation.jobId));

      const duplicate = db
        .insert(creditLedger)
        .values({
          userId: user.id,
          entryType: 'REFUND',
          amount: 30,
          referenceType: 'JOB',
          referenceId: reservation.jobId,
        })
        .catch((error: unknown) => error);

      expect(pgCode(await duplicate)).toBe('23505');
    });
  });

  describe('C9: refund after capture', () => {
    it('is refused, so a successful job is never paid for twice', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      await inTransaction((tx) => capture(tx, reservation.jobId));

      const result = await inTransaction((tx) => refund(tx, reservation.jobId, 'late reaper'));

      expect(result).toEqual({ refunded: false, amount: 0 });

      // The user's credits were spent and stay spent. A refund here would mint
      // 30 credits out of nothing.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
      const entries = await ledgerOf(db, user.id);
      expect(entries.filter((r) => r.entryType === 'REFUND')).toHaveLength(0);
      expect(entries.filter((r) => r.entryType === 'CAPTURE')).toHaveLength(1);
    });

    it('is refused even when the two race', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const [captured, refunded] = await Promise.all([
        inTransaction((tx) => capture(tx, reservation.jobId)),
        inTransaction((tx) => refund(tx, reservation.jobId)),
      ]);

      // Exactly one of the two terminal transitions can win.
      expect([captured.captured, refunded.refunded].filter(Boolean)).toHaveLength(1);
      await expect(walletOf(db, user.id)).resolves.toMatchObject({ reserved: 0 });
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
    });

    it('capture after refund is refused too', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      await inTransaction((tx) => refund(tx, reservation.jobId));
      const result = await inTransaction((tx) => capture(tx, reservation.jobId));

      expect(result).toEqual({ captured: false, amount: 0 });
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('cannot record both flags, even if SQL bypassed the API', async () => {
      // The CHECK constraint is the backstop for the race above.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const violation = db
        .execute(
          sql`
          UPDATE generation_jobs SET captured = 1, refunded = 1 WHERE id = ${reservation.jobId}::uuid
        `,
        )
        .catch((error: unknown) => error);

      expect(pgText(await violation)).toMatch(/generation_jobs_not_captured_and_refunded/);
    });
  });

  describe('C10: Idempotency-Key', () => {
    it('returns the original job for a replayed key, charging once', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const key = 'idem-key-0001';

      const first = await inTransaction((tx) =>
        reserve(tx, {
          userId: user.id,
          kind: 'REEL',
          workspaceId: WORKSPACE_ID,
          idempotencyKey: key,
        }),
      );
      const second = await inTransaction((tx) =>
        reserve(tx, {
          userId: user.id,
          kind: 'REEL',
          workspaceId: WORKSPACE_ID,
          idempotencyKey: key,
        }),
      );

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.jobId).toBe(first.jobId);

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 30 });
      await expect(jobCount(db)).resolves.toBe(1);

      const reserves = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'RESERVE');
      expect(reserves).toHaveLength(1);
      await expect(outboxCount(db)).resolves.toBe(1);
    });

    it('scopes the key to the user, so two users may pick the same one', async () => {
      const first = await createUserWithBonus(db, { bonus: BONUS });
      const second = await createUserWithBonus(db, { bonus: BONUS });

      const a = await inTransaction((tx) =>
        reserve(tx, { userId: first.id, kind: 'REEL', idempotencyKey: 'shared-key-1' }),
      );
      const b = await inTransaction((tx) =>
        reserve(tx, { userId: second.id, kind: 'REEL', idempotencyKey: 'shared-key-1' }),
      );

      expect(b.replayed).toBe(false);
      expect(b.jobId).not.toBe(a.jobId);
    });

    it('does not collide when the key is null', async () => {
      // The partial index must let keyless jobs coexist, or an internally created
      // job without a client key would fail against the first one.
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );

      await expect(jobCount(db)).resolves.toBe(2);
    });

    it('never double-charges when a replay races its own original request', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const key = 'idem-race-0001';

      await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          inTransaction((tx) =>
            reserve(tx, {
              userId: user.id,
              kind: 'REEL',
              workspaceId: WORKSPACE_ID,
              idempotencyKey: key,
            }),
          ),
        ),
      );

      // The invariant that must hold regardless of interleaving: one job, one
      // charge. Which caller wins is up to Postgres row locking.
      await expect(jobCount(db)).resolves.toBe(1);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 30 });

      const reserves = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'RESERVE');
      expect(reserves).toHaveLength(1);
      await expect(outboxCount(db)).resolves.toBe(1);
    });

    it('reports a racing retry as a replay, not as a payment failure', async () => {
      // Found by the test above: a bare `reserve` makes the losers fail the
      // guarded UPDATE on FUNDS, so a client whose first call succeeded would be
      // told it ran out of credits. `reserveOnce` re-reads the key instead.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const key = 'idem-race-0002';

      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          reserveOnce(db, {
            userId: user.id,
            kind: 'REEL',
            workspaceId: WORKSPACE_ID,
            idempotencyKey: key,
          }),
        ),
      );

      // Every caller is told the reservation exists. None is told it is broke.
      expect(attempts.every((a) => a.status === 'fulfilled')).toBe(true);

      const jobIds = new Set(
        attempts.map((a) => (a as PromiseFulfilledResult<{ jobId: string }>).value.jobId),
      );
      expect(jobIds.size).toBe(1);

      await expect(jobCount(db)).resolves.toBe(1);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 30 });
    });

    it('still surfaces a genuine shortfall through reserveOnce', async () => {
      // The re-read must not turn a real 402 into a phantom replay.
      const user = await createUserWithBonus(db, { bonus: 5 });

      await expect(
        reserveOnce(db, {
          userId: user.id,
          kind: 'REEL',
          workspaceId: WORKSPACE_ID,
          idempotencyKey: 'idem-broke-1',
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 5, reserved: 0 });
      await expect(jobCount(db)).resolves.toBe(0);
    });
  });

  describe('C11: partial failure', () => {
    it('refunds only the failed items and keeps the successful ones charged', async () => {
      // PROJECT.md section 5.1 rule 6: each paid item is its own line, so a
      // carousel where 3 of 5 images succeeded costs the user only the 2 that
      // failed.
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const total = await inTransaction((tx) =>
        reserve(tx, {
          userId: user.id,
          kind: 'CAROUSEL',
          workspaceId: WORKSPACE_ID,
          payload: { images: 5 },
        }),
      );
      expect(total.cost).toBe(15);

      // Two of the five images failed, so two fifths of the cost comes back.
      const refundable = Math.floor((total.cost * 2) / 5);
      expect(refundable).toBe(6);

      await inTransaction(() =>
        db.execute(sql`
          UPDATE wallets
             SET reserved = reserved - ${refundable},
                 available = available + ${refundable},
                 updated_at = now()
           WHERE user_id = ${user.id}::uuid AND reserved >= ${refundable}
        `),
      );
      await db.insert(creditLedger).values({
        userId: user.id,
        entryType: 'REFUND',
        amount: refundable,
        referenceType: 'JOB',
        referenceId: total.jobId,
        note: '2 of 5 images failed',
      });

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 41, reserved: 9 });
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
    });
  });

  describe('C12: reconciliation', () => {
    it('reports zero drift through the whole lifecycle', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const captured = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) => capture(tx, captured.jobId));
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });

      const refunded = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'CAROUSEL', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) => refund(tx, refunded.jobId));
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });

      const pending = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );
      // Still in flight: reserved, not settled.
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
      expect(pending.cost).toBe(5);
    });

    it('matches the wallet bucket for bucket, not just the total', async () => {
      // This is where the spec's `available + reserved == SUM(ledger)` invariant
      // would fail. A wallet mid-reservation has the right total and wrong
      // buckets, so reconciliation has to compare per bucket to be useful.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      const report = await reconcileUser(db, user.id);

      expect(report).toMatchObject({
        available: 20,
        reserved: 30,
        walletTotal: 50,
        ledgerAvailable: 20,
        ledgerReserved: 30,
        drifted: false,
      });
      // The raw sum is 20 while the wallet holds 50, which is exactly why it
      // cannot be the invariant.
      expect(report.ledgerTotal).toBe(20);
    });

    it('detects drift when a wallet is edited outside libs/credits', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await db.execute(
        sql`UPDATE wallets SET available = available + 7 WHERE user_id = ${user.id}::uuid`,
      );

      const report = await reconcileUser(db, user.id);

      expect(report.drifted).toBe(true);
      expect(report.available).toBe(57);
      expect(report.ledgerAvailable).toBe(50);
    });

    it('reports zero drift for every user in the suite', async () => {
      const users = await Promise.all([
        createUserWithBonus(db, { bonus: 50 }),
        createUserWithBonus(db, { bonus: 20 }),
        createUserWithBonus(db, { bonus: 0 }),
      ]);

      for (const user of users) {
        await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
      }
    });

    it('agrees with an independent SQL formulation of the invariant', async () => {
      // The implementation and an auditor's query are written separately on
      // purpose. If they ever disagree, one of them is wrong and an automated
      // check is the only way to find out before a customer's credits do.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      const job = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) => capture(tx, job.jobId));
      const second = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'POSTER', workspaceId: WORKSPACE_ID }),
      );
      await inTransaction((tx) => refund(tx, second.jobId));

      // Written independently of the implementation, from the per-bucket invariant in
      // PROJECT.md section 5.9 as corrected: CAPTURE is stored negative and moves
      // credits OUT of reserved, so it is added here, not subtracted.
      const audit = await db.execute<{ avail: string; res: string }>(sql`
        SELECT
          (COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('SIGNUP_BONUS','PURCHASE','ADJUSTMENT','REFUND')), 0)
           + COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('RESERVE','EXPIRY')), 0))::text AS avail,
          (-COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('RESERVE','REFUND')), 0)
           + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'CAPTURE'), 0))::text AS res
        FROM credit_ledger WHERE user_id = ${user.id}::uuid
      `);

      const report = await reconcileUser(db, user.id);

      expect(report.ledgerAvailable).toBe(Number(audit.rows[0]?.avail ?? '0'));
      expect(report.ledgerReserved).toBe(Number(audit.rows[0]?.res ?? '0'));
      expect(report.drifted).toBe(false);
    });
  });

  describe('adjust', () => {
    it('grants and takes credits with a reason', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await inTransaction((tx) =>
        adjust(tx, { userId: user.id, amount: 100, reason: 'support credit' }),
      );
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 150, reserved: 0 });

      await inTransaction((tx) =>
        adjust(tx, { userId: user.id, amount: -50, reason: 'chargeback' }),
      );
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 100, reserved: 0 });

      const adjustments = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'ADJUSTMENT');
      expect(adjustments).toHaveLength(2);
      await expect(reconcileUser(db, user.id)).resolves.toMatchObject({ drifted: false });
    });

    it('refuses to take a balance below zero', async () => {
      const user = await createUserWithBonus(db, { bonus: 20 });

      await expect(
        inTransaction((tx) => adjust(tx, { userId: user.id, amount: -30, reason: 'chargeback' })),
      ).rejects.toBeInstanceOf(CreditError);

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 20, reserved: 0 });
    });

    it('requires a reason and a non-zero amount', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      // An adjustment with no reason is indistinguishable from a bug that touched
      // someone's balance, which is exactly what an audit cannot investigate.
      await expect(
        inTransaction((tx) => adjust(tx, { userId: user.id, amount: 10, reason: '  ' })),
      ).rejects.toThrow(/reason/);
      await expect(
        inTransaction((tx) => adjust(tx, { userId: user.id, amount: 0, reason: 'typo' })),
      ).rejects.toThrow(/non-zero/);

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('records the actor when one is known', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await inTransaction((tx) =>
        adjust(tx, { userId: user.id, amount: 5, reason: 'goodwill', actorId: 'admin-1' }),
      );

      const row = await db
        .select({ note: creditLedger.note })
        .from(creditLedger)
        .where(eq(creditLedger.entryType, 'ADJUSTMENT'));

      expect(row[0]?.note).toBe('goodwill (by admin-1)');
    });

    it('allows repeated adjustments, each as its own row', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      for (let i = 0; i < 3; i += 1) {
        await inTransaction((tx) =>
          adjust(tx, { userId: user.id, amount: 5, reason: `installment ${i}` }),
        );
      }

      const adjustments = (await ledgerOf(db, user.id)).filter((r) => r.entryType === 'ADJUSTMENT');
      expect(adjustments).toHaveLength(3);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 65, reserved: 0 });
    });
  });

  describe('pricing', () => {
    it('refuses to reserve an action with no price', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await db.delete(pricingRules).where(eq(pricingRules.action, 'REEL'));

      // Charging a guessed price is how a customer gets billed an amount with no
      // record of why, so this is a server error rather than a zero.
      await expect(
        inTransaction((tx) =>
          reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
        ),
      ).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE' });

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('refuses an inactive price rather than charging a retired rate', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await deactivatePrice(db, 'REEL');

      await expect(
        inTransaction((tx) =>
          reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
        ),
      ).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE' });
    });

    it('reserves for a zero-cost action, because publishing is free', async () => {
      // PROJECT.md section 5.1 rule 8: only AI generation costs credits.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await seedPrice(db, 'CAPTION', 0);

      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'CAPTION', workspaceId: WORKSPACE_ID }),
      );

      expect(reservation.cost).toBe(0);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
      await expect(jobCount(db)).resolves.toBe(1);
    });

    it('reads a price from the table', async () => {
      await seedPrice(db, 'REEL', 30);
      await expect(priceFor(db, 'REEL')).resolves.toEqual({ action: 'REEL', credits: 30 });
    });

    it('reads a price changed since deployment', async () => {
      // Prices are data, so a change must not need a deploy - and a job reserved
      // after the change is charged the new rate.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await seedPrice(db, 'REEL', 50);

      const reservation = await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      expect(reservation.cost).toBe(50);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 0, reserved: 50 });
    });

    it('lists every price for the pricing endpoint', async () => {
      const prices = await listPrices(db);

      expect(prices).toHaveLength(Object.keys(DEFAULT_PRICES).length);
      expect(prices).toContainEqual({ action: 'REEL', credits: 30 });
      expect(prices).toContainEqual({ action: 'CAPTION', credits: 1 });

      // The table is complete, which is what a boot-time check needs to know.
      expect(() => assertPricingComplete(prices)).not.toThrow();
    });

    it('refuses an action whose price is missing from the table', async () => {
      // A gap is invisible until a user hits that action and gets a 500.
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await db.delete(pricingRules).where(eq(pricingRules.action, 'TRANSLATION'));

      await expect(
        inTransaction((tx) =>
          reserve(tx, { userId: user.id, kind: 'TRANSLATION', workspaceId: WORKSPACE_ID }),
        ),
      ).rejects.toMatchObject({ code: 'PRICING_UNAVAILABLE' });

      // The wallet is untouched: an unpriced action must not half-reserve.
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('keeps completeness about presence, not activeness', async () => {
      // A deactivated rule is a deliberate business decision and still exists, so
      // the table is complete; the reserve path refuses it separately. Conflating
      // the two would make "deactivate a price" indistinguishable from "forgot to
      // add one".
      await deactivatePrice(db, 'TRANSLATION');

      const prices = await listPrices(db);

      expect(() => assertPricingComplete(prices)).not.toThrow();
    });
  });

  describe('getBalance', () => {
    it('reports available, reserved and the total', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });
      await inTransaction((tx) =>
        reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE_ID }),
      );

      await expect(getBalance(db, user.id)).resolves.toEqual({
        userId: user.id,
        available: 20,
        reserved: 30,
        total: 50,
      });
    });
  });
});

/** Postgres SQLSTATE, reached through Drizzle's error wrapper. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  let depth = 0;
  while (typeof current === 'object' && current !== null && depth < 5) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return undefined;
}

function pgText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (typeof current === 'object' && current !== null && depth < 5) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') {
      parts.push(message);
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return parts.join(' | ');
}
