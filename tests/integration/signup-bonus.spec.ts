import type { PrismaClient } from '@prisma/client';

import {
  CreditError,
  getBalance,
  grantSignupBonus,
  reconcileUser,
  signupBonusCredits,
} from '@renderflow/credits';

import { FAST_ARGON2_OPTIONS, hashPassword } from '../../apps/api/src/auth/password';
import { createUserWithBonus, ledgerOf, uniqueEmail, walletOf } from './helpers/auth-fixtures';
import { setupTestDatabase, teardownTestDatabase } from './helpers/test-database';

/**
 * PROJECT.md section 13.2 credit tests C1, C2 and C12, plus the signup-bonus
 * invariants from section 5.1. These run against a real Postgres because the
 * guarantees (unique index, transaction) are enforced by the database itself.
 */
describe('signup bonus (C1, C2)', () => {
  let prisma: PrismaClient;
  const BONUS = 50;

  beforeAll(async () => {
    prisma = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(prisma);
  });

  describe('C1: a new user receives exactly the configured bonus', () => {
    it('grants 50 credits and exactly one SIGNUP_BONUS ledger row', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      const wallet = await walletOf(prisma, user.id);
      expect(wallet).toEqual({ available: BONUS, reserved: 0 });

      const ledger = await ledgerOf(prisma, user.id);
      const bonusRows = ledger.filter((entry) => entry.entryType === 'SIGNUP_BONUS');
      expect(bonusRows).toHaveLength(1);
      expect(bonusRows[0]?.amount).toBe(BONUS);
      expect(bonusRows[0]?.referenceType).toBe('SYSTEM');
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
      const user = await createUserWithBonus(prisma, { bonus: 12 });
      await expect(walletOf(prisma, user.id)).resolves.toEqual({ available: 12, reserved: 0 });
    });

    it('creates the wallet in the same transaction as the user', async () => {
      const email = uniqueEmail('atomic');
      const passwordHash = await hashPassword('AtomicityCheck123', FAST_ARGON2_OPTIONS);
      const systemRowsBefore = await prisma.creditLedger.count({
        where: { referenceType: 'SYSTEM' },
      });

      await prisma
        .$transaction(async (tx) => {
          const created = await tx.user.create({
            data: { email, passwordHash, name: 'Atomic' },
            select: { id: true },
          });
          await grantSignupBonus(tx, { userId: created.id, amount: 50 });

          // Force the transaction to abort after the bonus was written.
          throw new Error('forced rollback');
        })
        .catch(() => undefined);

      // Nothing may survive the rollback: not the user, not the wallet, and not
      // the ledger row. This is what proves the bonus is atomic with the
      // user insert rather than written by a separate, unguarded step.
      const survivors = await prisma.user.findMany({ where: { email } });
      expect(survivors).toHaveLength(0);
      await expect(prisma.creditLedger.count({ where: { referenceType: 'SYSTEM' } })).resolves.toBe(
        systemRowsBefore,
      );
    });
  });

  describe('C2: registering the same email twice grants the bonus once', () => {
    it('creates exactly one user and one bonus for a duplicate email', async () => {
      const email = uniqueEmail('dupe');

      const first = await createUserWithBonus(prisma, { email, bonus: BONUS });

      await expect(
        prisma.user.create({
          data: { email, passwordHash: 'x', name: 'Impostor' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const users = await prisma.user.findMany({ where: { email } });
      expect(users).toHaveLength(1);
      expect(users[0]?.id).toBe(first.id);

      const ledger = await ledgerOf(prisma, first.id);
      expect(ledger.filter((e) => e.entryType === 'SIGNUP_BONUS')).toHaveLength(1);
      await expect(walletOf(prisma, first.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('rejects 20 concurrent registrations of one email, granting the bonus once', async () => {
      const email = uniqueEmail('race');
      const passwordHash = await hashPassword('ConcurrentRace123', FAST_ARGON2_OPTIONS);

      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, async () =>
          prisma.$transaction(async (tx) => {
            const created = await tx.user.create({
              data: { email, passwordHash, name: 'Racer' },
              select: { id: true },
            });
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
        expect(failure.reason).toMatchObject({ code: 'P2002' });
      }

      const users = await prisma.user.findMany({ where: { email } });
      expect(users).toHaveLength(1);

      const userId = users[0]?.id as string;
      const ledger = await ledgerOf(prisma, userId);
      expect(ledger.filter((e) => e.entryType === 'SIGNUP_BONUS')).toHaveLength(1);
      await expect(walletOf(prisma, userId)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });

    it('grants the bonus once even if grantSignupBonus is called twice', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      await grantSignupBonus(prisma, { userId: user.id, amount: BONUS });

      // Idempotent: the unique index makes the second grant a no-op.
      const ledger = await ledgerOf(prisma, user.id);
      expect(ledger.filter((e) => e.entryType === 'SIGNUP_BONUS')).toHaveLength(1);
      await expect(walletOf(prisma, user.id)).resolves.toEqual({ available: BONUS, reserved: 0 });
    });
  });

  describe('database-level invariants', () => {
    it('rejects a negative balance at the database level', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      await expect(
        prisma.$executeRaw`UPDATE wallets SET available = -1 WHERE user_id = ${user.id}::uuid`,
      ).rejects.toThrow(/wallets_available_non_negative/);
    });

    it('rejects a negative reserved balance', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      await expect(
        prisma.$executeRaw`UPDATE wallets SET reserved = -1 WHERE user_id = ${user.id}::uuid`,
      ).rejects.toThrow(/wallets_reserved_non_negative/);
    });

    it('rejects a second SIGNUP_BONUS row for the same user', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      await expect(
        prisma.creditLedger.create({
          data: { userId: user.id, entryType: 'SIGNUP_BONUS', amount: 10 },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects duplicate ledger idempotency keys', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      const entry = {
        userId: user.id,
        entryType: 'RESERVE' as const,
        amount: -5,
        referenceType: 'JOB',
        referenceId: 'job-dup-1',
      };

      await prisma.creditLedger.create({ data: entry });

      // Same (reference_type, reference_id, entry_type) must collide.
      await expect(prisma.creditLedger.create({ data: entry })).rejects.toMatchObject({
        code: 'P2002',
      });
    });
  });

  describe('C12: reconciliation', () => {
    it('reports zero drift for a freshly registered user', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      const report = await reconcileUser(prisma, user.id);

      expect(report).not.toBeNull();
      expect(report?.drifted).toBe(false);
      expect(report?.walletTotal).toBe(BONUS);
      expect(report?.ledgerTotal).toBe(BONUS);
    });

    it('detects drift when a wallet is edited outside libs/credits', async () => {
      const user = await createUserWithBonus(prisma, { bonus: BONUS });

      // Simulate the exact corruption reconciliation exists to catch.
      await prisma.$executeRaw`UPDATE wallets SET available = available + 7 WHERE user_id = ${user.id}::uuid`;

      const report = await reconcileUser(prisma, user.id);
      expect(report?.drifted).toBe(true);
      expect(report?.walletTotal).toBe(BONUS + 7);
      expect(report?.ledgerTotal).toBe(BONUS);
    });

    it('reports zero drift across every user in the suite', async () => {
      const users = await Promise.all([
        createUserWithBonus(prisma, { bonus: 50 }),
        createUserWithBonus(prisma, { bonus: 20 }),
        createUserWithBonus(prisma, { bonus: 0 }),
      ]);

      for (const user of users) {
        const report = await reconcileUser(prisma, user.id);
        expect(report?.drifted).toBe(false);
      }
    });
  });

  describe('getBalance', () => {
    it('returns the balance with a computed total', async () => {
      const user = await createUserWithBonus(prisma, { bonus: 50 });
      await expect(getBalance(prisma, user.id)).resolves.toEqual({
        userId: user.id,
        available: 50,
        reserved: 0,
        total: 50,
      });
    });

    it('throws WALLET_NOT_FOUND for a user with no wallet', async () => {
      const user = await prisma.user.create({
        data: {
          email: uniqueEmail('nowallet'),
          passwordHash: await hashPassword('NoWalletUser123', FAST_ARGON2_OPTIONS),
          name: 'No Wallet',
        },
        select: { id: true },
      });

      await expect(getBalance(prisma, user.id)).rejects.toMatchObject({
        code: 'WALLET_NOT_FOUND',
      });
    });
  });
});
