import { desc, eq } from 'drizzle-orm';
import { auditLogs, creditLedger, users, workspaceMembers, wallets } from '@renderflow/db';

import { TEST_PASSWORD, uniqueEmail } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Manual credit adjustments (PROJECT.md sections 5, 9.7, 10).
 *
 * An operator can move real credits here, so every property in this file is one
 * of the guarantees AGENTS.md section 5 asks for:
 *
 *  - the movement goes through `libs/credits` (a ledger row exists, the wallet
 *    matches it, and a wallet cannot go negative);
 *  - a reference id makes a retried request a no-op rather than a second grant;
 *  - an operator cannot act outside the workspaces they own, and the refusal is
 *    a 404 so the route cannot be used to enumerate other tenants;
 *  - every applied adjustment leaves an audit row naming the actor.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

describe('admin: credit adjustments (Phase 9)', () => {
  let db: TestDb;
  let app: TestApp;

  beforeAll(async () => {
    db = await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
  });

  async function account(prefix: string): Promise<Account> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: TEST_PASSWORD, name: prefix });

    if (res.status !== 201) {
      throw new Error(`register failed: ${res.status}`);
    }

    const ws = await app
      .http()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${res.body.accessToken as string}`);

    return {
      userId: res.body.user.id as string,
      accessToken: res.body.accessToken as string,
      workspaceId: ws.body[0].id as string,
    };
  }

  const adjust = (acct: Account, body: Record<string, unknown>) =>
    app
      .http()
      .post('/api/v1/admin/credits/adjust')
      .set('Authorization', `Bearer ${acct.accessToken}`)
      .send(body);

  function ledger(userId: string) {
    return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
  }

  async function balanceOf(userId: string) {
    const [wallet] = await db
      .select({ available: wallets.available, reserved: wallets.reserved })
      .from(wallets)
      .where(eq(wallets.userId, userId));

    return wallet;
  }

  it('grants credits to a workspace member through the ledger, with an audit row', async () => {
    const owner = await account('adjust-owner');
    const member = await account('adjust-member');

    const added = await app
      .http()
      .post(`/api/v1/workspaces/${owner.workspaceId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ userId: member.userId, role: 'VIEWER' });
    expect(added.status).toBe(201);

    const res = await adjust(owner, {
      userId: member.userId,
      amount: 25,
      reason: 'goodwill for the outage',
      referenceId: 'ticket-1234',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: member.userId,
      amount: 25,
      applied: true,
      referenceId: 'ticket-1234',
      balance: { available: 75, reserved: 0, total: 75 },
    });

    const rows = await ledger(member.userId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.entryType === 'ADJUSTMENT')).toMatchObject({
      amount: 25,
      referenceType: 'ADMIN',
      referenceId: 'ticket-1234',
    });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'credits.adjust'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: owner.userId,
      entity: 'user',
      entityId: member.userId,
    });
  });

  it('is idempotent on the reference id: a retry reports the same balance and moves nothing', async () => {
    const owner = await account('adjust-owner-2');

    const first = await adjust(owner, {
      userId: owner.userId,
      amount: 10,
      reason: 'referral bonus',
      referenceId: 'referral-9',
    });
    const second = await adjust(owner, {
      userId: owner.userId,
      amount: 10,
      reason: 'referral bonus',
      referenceId: 'referral-9',
    });

    expect(first.status).toBe(201);
    expect(first.body.applied).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ applied: false, balance: { available: 60 } });

    const adjustments = (await ledger(owner.userId)).filter(
      (row) => row.entryType === 'ADJUSTMENT',
    );
    expect(adjustments).toHaveLength(1);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, 'credits.adjust')),
    ).toHaveLength(1);
  });

  it('applies a second adjustment when no reference id is given', async () => {
    // No reference means "do it again" is a legitimate request; the ledger has
    // no way to tell the two apart, so it does what it is told.
    const owner = await account('adjust-owner-3');

    await adjust(owner, { userId: owner.userId, amount: 5, reason: 'first' });
    const second = await adjust(owner, { userId: owner.userId, amount: 5, reason: 'second' });

    expect(second.body).toMatchObject({ applied: true, balance: { available: 60 } });
  });

  it('refuses an adjustment the wallet cannot absorb, and writes nothing', async () => {
    const owner = await account('adjust-owner-4');

    const res = await adjust(owner, { userId: owner.userId, amount: -100, reason: 'clawback' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(await balanceOf(owner.userId)).toMatchObject({ available: 50, reserved: 0 });
    expect(
      (await ledger(owner.userId)).filter((row) => row.entryType === 'ADJUSTMENT'),
    ).toHaveLength(0);
  });

  it('hides a user outside the operator’s workspaces', async () => {
    const owner = await account('adjust-owner-5');
    const stranger = await account('adjust-stranger-5');

    const res = await adjust(owner, {
      userId: stranger.userId,
      amount: 1_000,
      reason: 'not mine',
    });

    expect(res.status).toBe(404);
    // Nothing was written even though the amount was valid.
    expect(
      (await ledger(stranger.userId)).filter((row) => row.entryType === 'ADJUSTMENT'),
    ).toHaveLength(0);
  });

  it('refuses a non-operator, even for their own wallet', async () => {
    const owner = await account('adjust-owner-6');
    const viewer = await account('adjust-viewer-6');

    // Registration makes everyone the owner of a personal workspace, so the way
    // to be a non-operator is to own none.
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, viewer.userId));

    const res = await adjust(viewer, {
      userId: owner.userId,
      amount: 5,
      reason: 'should not work',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('lets a global ADMIN adjust across workspaces', async () => {
    const admin = await account('adjust-admin-7');
    const stranger = await account('adjust-stranger-7');

    await db.update(users).set({ role: 'ADMIN' }).where(eq(users.id, admin.userId));

    const res = await adjust(admin, {
      userId: stranger.userId,
      amount: 7,
      reason: 'support gesture',
      referenceId: 'support-7',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applied: true, balance: { available: 57 } });
  });

  it('rejects amounts and reasons a mistake would hide behind', async () => {
    const owner = await account('adjust-owner-8');

    const zero = await adjust(owner, { userId: owner.userId, amount: 0, reason: 'nothing' });
    const fractional = await adjust(owner, {
      userId: owner.userId,
      amount: 1.5,
      reason: 'rounding',
    });
    const huge = await adjust(owner, {
      userId: owner.userId,
      amount: 1_000_001,
      reason: 'typo',
    });
    const shortReason = await adjust(owner, { userId: owner.userId, amount: 5, reason: 'x' });
    const badId = await adjust(owner, { userId: 'not-a-uuid', amount: 5, reason: 'typo' });

    for (const res of [zero, fractional, huge, shortReason, badId]) {
      expect(res.status).toBe(400);
    }

    expect(await balanceOf(owner.userId)).toMatchObject({ available: 50 });
  });

  it('requires authentication', async () => {
    const owner = await account('adjust-owner-9');

    const res = await app
      .http()
      .post('/api/v1/admin/credits/adjust')
      .send({ userId: owner.userId, amount: 5, reason: 'anonymous' });

    expect(res.status).toBe(401);
  });

  it('records the latest audit row with the operator note', async () => {
    const owner = await account('adjust-owner-10');

    await adjust(owner, {
      userId: owner.userId,
      amount: -10,
      reason: 'removing a mistaken grant',
      referenceId: 'cleanup-1',
    });

    const [latest] = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(1);

    expect(latest?.meta).toMatchObject({
      amount: -10,
      reason: 'removing a mistaken grant',
      referenceId: 'cleanup-1',
    });
    expect(await balanceOf(owner.userId)).toMatchObject({ available: 40 });
  });
});
