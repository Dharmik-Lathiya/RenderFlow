import { and, eq, sql } from 'drizzle-orm';

import { grantSignupBonus } from '@renderflow/credits';
import { creditLedger, users, wallets } from '@renderflow/db';

import { FAST_ARGON2_OPTIONS, hashPassword } from '../../../apps/api/src/auth/password';
import type { TestDb } from './test-database';

/**
 * Shared fixtures for integration suites.
 *
 * The signup bonus must come from `libs/credits` (AGENTS.md rule 1), so even test
 * setup goes through it rather than inserting wallet rows directly. Otherwise a
 * test could pass while violating the invariant the suite exists to protect.
 */

export const TEST_PASSWORD = 'IntegrationTest123';

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

let counter = 0;

/** Unique per call so tests never collide on the `users.email` unique index. */
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${counter}-${process.pid}@example.test`;
}

export async function createUserWithBonus(
  db: TestDb,
  input: { email?: string; name?: string; bonus: number; passwordHash?: string },
): Promise<CreatedUser> {
  const email = input.email ?? uniqueEmail();
  const passwordHash =
    input.passwordHash ?? (await hashPassword(TEST_PASSWORD, FAST_ARGON2_OPTIONS));

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, name: input.name ?? 'Test User' })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
      });

    if (user === undefined) {
      throw new Error('user insert returned no row');
    }

    await grantSignupBonus(tx, { userId: user.id, amount: input.bonus });
    return user;
  });
}

/** Wallet balance straight from the DB, bypassing any cache. */
export async function walletOf(
  db: TestDb,
  userId: string,
): Promise<{ available: number; reserved: number } | null> {
  const rows = await db
    .select({ available: wallets.available, reserved: wallets.reserved })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function ledgerOf(
  db: TestDb,
  userId: string,
): Promise<
  Array<{
    entryType: string;
    amount: number;
    referenceType: string | null;
    referenceId: string | null;
  }>
> {
  return db
    .select({
      entryType: creditLedger.entryType,
      amount: creditLedger.amount,
      referenceType: creditLedger.referenceType,
      referenceId: creditLedger.referenceId,
    })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(sql`${creditLedger.createdAt} ASC`);
}

/** Convenience predicate for the signup-bonus-only case. */
export async function signupBonusRows(db: TestDb, userId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.entryType, 'SIGNUP_BONUS')));
  return rows.length;
}
