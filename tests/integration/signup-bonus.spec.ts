import { eq, sql } from 'drizzle-orm';

import {
  CreditError,
  getBalance,
  grantSignupBonus,
  reconcileUser,
  signupBonusCredits,
} from '@renderflow/credits';
import { creditLedger, users } from '@renderflow/db';

import { FAST_ARGON2_OPTIONS, hashPassword } from '../../apps/api/src/auth/password';
import {
  createUserWithBonus,
  ledgerOf,
  signupBonusRows,
  uniqueEmail,
  walletOf,
} from './helpers/auth-fixtures';
import {
  pgErrorCode,
  pgErrorText,
  setupTestDatabase,
  teardownTestDatabase,
  type TestDb,
} from './helpers/test-database';

/** Postgres unique_violation, surfaced through Drizzle's error wrapper. */
const UNIQUE_VIOLATION = '23505';

/**
 * PROJECT.md section 13.2 credit tests C1, C2 and C12, plus the signup-bonus
 * invariants from section 5.1.
 *
 * These run against a real Postgres because the guarantees are enforced by the
 * database itself: the partial unique index that makes the bonus once-only, the
 * CHECK constraints that refuse a negative balance, and transaction rollback.
 * A mocked database would assert nothing.
 */
describe('signup bonus (C1, C2)', () => {
  let db: TestDb;
  const BONUS = 50;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  describe('C1: a new user receives exactly the configured bonus', () => {
    it('grants 50 credits and exactly one SIGNUP_BONUS ledger row', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });

      await expect(signupBonusRows(db, user.id)).resolves.toBe(1);

      const ledger = await ledgerOf(db, user.id);
      expect(ledger[0]).toMatchObject({
        entryType: 'SIGNUP_BONUS',
        amount: BONUS,
        referenceType: 'SYSTEM',
      });
    });

    it('reads the amount from config, never from a literal', () => {
      expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '50' })).toBe(50);
      expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '0' })).toBe(0);
      expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '  75 ' })).toBe(75);
    });

    it('refuses to run without SIGNUP_BONUS_CREDITS rather than granting 0', () => {
      // Silently granting zero would look like a bug in the credit engine.
      expect(() => signupBonusCredits({})).toThrow(CreditError);
      expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: '-5' })).toThrow(CreditError);
      expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: 'many' })).toThrow(CreditError);
    });

    it('honours a non-default configured amount end to end', async () => {
      const user = await createUserWithBonus(db, { bonus: 12 });
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: 12, reserved: 0 });
    });

    it('creates the wallet in the same transaction as the user', async () => {
      const email = uniqueEmail('atomic');
      const passwordHash = await hashPassword('AtomicityCheck123', FAST_ARGON2_OPTIONS);
      const systemRowsBefore = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.referenceType, 'SYSTEM'));

      await db
        .transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({ email, passwordHash, name: 'Atomic' })
            .returning({ id: users.id });

          if (created === undefined) {
            throw new Error('no user row');
          }
          await grantSignupBonus(tx, { userId: created.id, amount: 50 });

          // Force the transaction to abort after the bonus was written.
          throw new Error('forced rollback');
        })
        .catch(() => undefined);

      // Nothing may survive: not the user, not the wallet, not the ledger row.
      const survivors = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(survivors).toHaveLength(0);

      const systemRowsAfter = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(creditLedger.referenceType, 'SYSTEM'));
      expect(systemRowsAfter).toHaveLength(systemRowsBefore.length);
    });
  });

  describe('C2: registering the same email twice grants the bonus once', () => {
    it('creates exactly one user and one bonus for a duplicate email', async () => {
      const email = uniqueEmail('dupe');
      const first = await createUserWithBonus(db, { email, bonus: BONUS });

      // A second insert must collide with the unique index on users.email.
      const duplicate = db
        .insert(users)
        .values({ email, passwordHash: 'x', name: 'Impostor' })
        .catch((error: unknown) => error);
      expect(pgErrorCode(await duplicate)).toBe(UNIQUE_VIOLATION);

      const all = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(first.id);

      await expect(signupBonusRows(db, first.id)).resolves.toBe(1);
      await expect(walletOf(db, first.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('rejects 20 concurrent registrations of one email, granting the bonus once', async () => {
      const email = uniqueEmail('race');
      const passwordHash = await hashPassword('ConcurrentRace123', FAST_ARGON2_OPTIONS);

      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, async () =>
          db.transaction(async (tx) => {
            const [created] = await tx
              .insert(users)
              .values({ email, passwordHash, name: 'Racer' })
              .returning({ id: users.id });
            if (created === undefined) {
              throw new Error('no user row');
            }
            await grantSignupBonus(tx, { userId: created.id, amount: BONUS });
            return created.id;
          }),
        ),
      );

      const succeeded = attempts.filter((a) => a.status === 'fulfilled');
      const failed = attempts.filter((a) => a.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(19);
      // Every rejection is the unique-email violation, not a crash.
      for (const failure of failed) {
        expect(pgErrorCode(failure.reason)).toBe(UNIQUE_VIOLATION);
      }

      const all = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(all).toHaveLength(1);

      const userId = all[0]?.id as string;
      // The invariant that matters: exactly one grant of 50 credits.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: BONUS, reserved: 0 });
      await expect(signupBonusRows(db, userId)).resolves.toBe(1);
    });

    it('grants the bonus once even if grantSignupBonus is called twice', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      // Idempotent: the partial unique index makes the second grant a no-op.
      await grantSignupBonus(db, { userId: user.id, amount: BONUS });

      await expect(signupBonusRows(db, user.id)).resolves.toBe(1);
      await expect(walletOf(db, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });
  });

  describe('database-level invariants', () => {
    it('rejects a negative balance at the database level', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const failure = db
        .execute(sql`UPDATE wallets SET available = -1 WHERE user_id = ${user.id}::uuid`)
        .catch((error: unknown) => error);
      expect(pgErrorText(await failure)).toMatch(/wallets_available_non_negative/);
    });

    it('rejects a negative reserved balance', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const failure = db
        .execute(sql`UPDATE wallets SET reserved = -1 WHERE user_id = ${user.id}::uuid`)
        .catch((error: unknown) => error);
      expect(pgErrorText(await failure)).toMatch(/wallets_reserved_non_negative/);
    });

    it('rejects a second SIGNUP_BONUS row for the same user', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const duplicate = db
        .insert(creditLedger)
        .values({ userId: user.id, entryType: 'SIGNUP_BONUS', amount: 10 })
        .catch((error: unknown) => error);
      expect(pgErrorCode(await duplicate)).toBe(UNIQUE_VIOLATION);
    });

    it('rejects duplicate ledger idempotency keys', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const entry = {
        userId: user.id,
        entryType: 'RESERVE' as const,
        amount: -5,
        referenceType: 'JOB',
        referenceId: 'job-dup-1',
      };

      await db.insert(creditLedger).values(entry);

      // Same (reference_type, reference_id, entry_type) must collide.
      const duplicate = db
        .insert(creditLedger)
        .values(entry)
        .catch((error: unknown) => error);
      expect(pgErrorCode(await duplicate)).toBe(UNIQUE_VIOLATION);
    });

    it('allows many ledger rows for the same user without a reference', async () => {
      // SYSTEM entries have no reference_type, so the partial index must not
      // collide them; only the entry type scopes uniqueness.
      const user = await createUserWithBonus(db, { bonus: 10 });

      await db.insert(creditLedger).values({
        userId: user.id,
        entryType: 'ADJUSTMENT',
        amount: 5,
        referenceType: null,
        referenceId: null,
      });

      await db.insert(creditLedger).values({
        userId: user.id,
        entryType: 'ADJUSTMENT',
        amount: 5,
        referenceType: null,
        referenceId: null,
      });

      const rows = await ledgerOf(db, user.id);
      expect(rows.filter((r) => r.entryType === 'ADJUSTMENT')).toHaveLength(2);
    });
  });

  describe('C12: reconciliation', () => {
    it('reports zero drift for a freshly registered user', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      const report = await reconcileUser(db, user.id);

      expect(report).not.toBeNull();
      expect(report?.drifted).toBe(false);
      expect(report?.walletTotal).toBe(BONUS);
      expect(report?.ledgerTotal).toBe(BONUS);
    });

    it('detects drift when a wallet is edited outside libs/credits', async () => {
      const user = await createUserWithBonus(db, { bonus: BONUS });

      // Simulate the exact corruption reconciliation exists to catch.
      await db.execute(
        sql`UPDATE wallets SET available = available + 7 WHERE user_id = ${user.id}::uuid`,
      );

      const report = await reconcileUser(db, user.id);
      expect(report?.drifted).toBe(true);
      expect(report?.walletTotal).toBe(BONUS + 7);
      expect(report?.ledgerTotal).toBe(BONUS);
    });

    it('reports zero drift across every user in the suite', async () => {
      const created = await Promise.all([
        createUserWithBonus(db, { bonus: 50 }),
        createUserWithBonus(db, { bonus: 20 }),
        createUserWithBonus(db, { bonus: 0 }),
      ]);

      for (const user of created) {
        const report = await reconcileUser(db, user.id);
        expect(report?.drifted).toBe(false);
      }
    });
  });

  describe('getBalance', () => {
    it('returns the balance with a computed total', async () => {
      const user = await createUserWithBonus(db, { bonus: 50 });
      await expect(getBalance(db, user.id)).resolves.toEqual({
        userId: user.id,
        available: 50,
        reserved: 0,
        total: 50,
      });
    });

    it('throws WALLET_NOT_FOUND for a user with no wallet', async () => {
      const email = uniqueEmail('nowallet');
      await db.insert(users).values({
        email,
        passwordHash: await hashPassword('NoWalletUser123', FAST_ARGON2_OPTIONS),
        name: 'No Wallet',
      });

      const created = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(created).toHaveLength(1);

      const userId = created[0]?.id;
      if (userId === undefined) {
        throw new Error('user insert returned no row');
      }

      await expect(getBalance(db, userId)).rejects.toMatchObject({
        code: 'WALLET_NOT_FOUND',
      });
    });
  });
});
