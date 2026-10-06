import { type PrismaClient } from '@prisma/client';

/**
 * Shared fixtures for integration suites.
 *
 * The signup bonus must come from `libs/credits` (AGENTS.md rule 1), so even test
 * setup goes through it rather than inserting wallet rows directly. Otherwise a
 * test could pass while violating the invariant the suite is meant to protect.
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
  client: PrismaClient,
  input: {
    email?: string;
    name?: string;
    bonus: number;
    passwordHash?: string;
  },
): Promise<CreatedUser> {
  const { grantSignupBonus } = await import('@renderflow/credits');
  const { hashPassword, FAST_ARGON2_OPTIONS } = await import('../../../apps/api/src/auth/password');

  const email = input.email ?? uniqueEmail();
  const passwordHash =
    input.passwordHash ?? (await hashPassword(TEST_PASSWORD, FAST_ARGON2_OPTIONS));

  const user = await client.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        name: input.name ?? 'Test User',
      },
      select: { id: true, email: true, name: true, passwordHash: true },
    });

    await grantSignupBonus(tx, { userId: created.id, amount: input.bonus });
    return created;
  });

  return user;
}

/** Wallet balance straight from the DB, bypassing any cache. */
export async function walletOf(
  client: PrismaClient,
  userId: string,
): Promise<{
  available: number;
  reserved: number;
} | null> {
  return client.wallet.findUnique({
    where: { userId },
    select: { available: true, reserved: true },
  });
}

export async function ledgerOf(
  client: PrismaClient,
  userId: string,
): Promise<
  Array<{
    entryType: string;
    amount: number;
    referenceType: string | null;
    referenceId: string | null;
  }>
> {
  return client.creditLedger.findMany({
    where: { userId },
    select: { entryType: true, amount: true, referenceType: true, referenceId: true },
    orderBy: { createdAt: 'asc' },
  });
}
