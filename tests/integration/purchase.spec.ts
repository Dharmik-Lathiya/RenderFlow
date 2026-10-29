import { and, eq } from 'drizzle-orm';

import { CreditError, getBalance, purchase, reconcileUser } from '@renderflow/credits';
import { creditLedger, users } from '@renderflow/db';

import { createUserWithBonus, ledgerOf, uniqueEmail, walletOf } from './helpers/auth-fixtures';
import { setupTestDatabase, teardownTestDatabase, type TestDb } from './helpers/test-database';

/**
 * The PURCHASE ledger path (PROJECT.md section 5.3).
 *
 * A top-up is the one credit movement that ADDS money rather than spending it,
 * so its failure mode is the expensive one: a provider retry must not credit the
 * same order twice. The idempotency guarantee lives in the partial unique index
 * on `(reference_type, reference_id, entry_type)`, which is why these tests run
 * against a real Postgres and drive the same `purchase()` the stub endpoint
 * calls.
 *
 * There is no payment provider wired yet. These tests cover the ledger and
 * wallet behaviour a future provider adapter will depend on.
 */
describe('purchases (PURCHASE ledger path)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await teardownTestDatabase(db);
  });

  async function inTransaction<T>(
    fn: (tx: Parameters<Parameters<TestDb['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => fn(tx));
  }

  async function purchaseRows(userId: string) {
    return db
      .select({
        amount: creditLedger.amount,
        referenceType: creditLedger.referenceType,
        referenceId: creditLedger.referenceId,
        note: creditLedger.note,
      })
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, userId), eq(creditLedger.entryType, 'PURCHASE')));
  }

  it('credits the wallet exactly once and records a PURCHASE row', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    const result = await inTransaction((tx) =>
      purchase(tx, {
        userId: user.id,
        credits: 25,
        referenceId: '  order-abc  ',
        provider: 'stripe',
        note: 'paid in full',
      }),
    );

    expect(result).toEqual({ applied: true });
    await expect(walletOf(db, user.id)).resolves.toEqual({ available: 75, reserved: 0 });

    const rows = await purchaseRows(user.id);
    expect(rows).toEqual([
      {
        amount: 25,
        referenceType: 'PURCHASE',
        // Trimmed before use, so a webhook that pads the id still dedupes.
        referenceId: 'order-abc',
        note: 'paid in full',
      },
    ]);
  });

  it('is idempotent on the provider reference', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    const first = await inTransaction((tx) =>
      purchase(tx, {
        userId: user.id,
        credits: 25,
        referenceId: 'order-retry',
        provider: 'stripe',
      }),
    );
    const second = await inTransaction((tx) =>
      purchase(tx, {
        userId: user.id,
        credits: 25,
        referenceId: 'order-retry',
        provider: 'stripe',
      }),
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    await expect(walletOf(db, user.id)).resolves.toEqual({ available: 75, reserved: 0 });

    const purchases = await purchaseRows(user.id);
    expect(purchases).toHaveLength(1);
  });

  it('uses the provider fallback note when no note is supplied', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    await inTransaction((tx) =>
      purchase(tx, {
        userId: user.id,
        credits: 10,
        referenceId: 'order-no-note',
        provider: 'razorpay',
      }),
    );

    const rows = await purchaseRows(user.id);
    expect(rows[0]?.note).toBe('purchase via razorpay');
  });

  it('refuses a zero-credit purchase without writing anything', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    await expect(
      inTransaction((tx) =>
        purchase(tx, {
          userId: user.id,
          credits: 0,
          referenceId: 'order-zero',
          provider: 'stub',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });
    expect(await purchaseRows(user.id)).toHaveLength(0);
  });

  it('refuses a blank provider reference', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    await expect(
      inTransaction((tx) =>
        purchase(tx, {
          userId: user.id,
          credits: 10,
          referenceId: '   ',
          provider: 'stub',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    expect(await purchaseRows(user.id)).toHaveLength(0);
  });

  it('refuses negative and non-integer credit amounts', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    for (const credits of [-1, 1.5]) {
      await expect(
        inTransaction((tx) =>
          purchase(tx, {
            userId: user.id,
            credits,
            referenceId: `order-invalid-${String(credits)}`,
            provider: 'stub',
          }),
        ),
      ).rejects.toBeInstanceOf(CreditError);
    }

    await expect(walletOf(db, user.id)).resolves.toEqual({ available: 50, reserved: 0 });
    expect(await purchaseRows(user.id)).toHaveLength(0);
  });

  it('rolls back the ledger row when the wallet does not exist', async () => {
    // Deliberately no signup bonus: this user has a users row and no wallet.
    // A ledger row that survives without a wallet would be invisible credits
    // until reconciliation found them, so the transaction must leave neither.
    const [user] = await db
      .insert(users)
      .values({ email: uniqueEmail('no-wallet'), passwordHash: 'x', name: 'No Wallet' })
      .returning({ id: users.id });

    if (user === undefined) {
      throw new Error('user insert returned no row');
    }

    await expect(
      inTransaction((tx) =>
        purchase(tx, {
          userId: user.id,
          credits: 10,
          referenceId: 'order-no-wallet',
          provider: 'stub',
        }),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });

    const rows = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.id));
    expect(rows).toHaveLength(0);
    await expect(getBalance(db, user.id)).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('leaves the wallet and ledger reconcilable afterwards', async () => {
    const user = await createUserWithBonus(db, { bonus: 50 });

    await inTransaction((tx) =>
      purchase(tx, {
        userId: user.id,
        credits: 40,
        referenceId: 'order-reconcile',
        provider: 'stub',
      }),
    );

    const report = await reconcileUser(db, user.id);
    expect(report).toMatchObject({
      walletTotal: 90,
      ledgerTotal: 90,
      drifted: false,
    });
    expect((await ledgerOf(db, user.id)).map((row) => row.entryType)).toEqual([
      'SIGNUP_BONUS',
      'PURCHASE',
    ]);
  });
});
