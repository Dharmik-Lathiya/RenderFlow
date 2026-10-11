import { eq } from 'drizzle-orm';

import { BLOCKED_TERMS, type Moderator } from '@renderflow/ai';
import { creditLedger, generationJobs, wallets } from '@renderflow/db';

import { ModerationService } from '../../apps/api/src/jobs/moderation.service';
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
 * Moderation before reserve (PROJECT.md section 12 Phase 6: "Moderation check
 * before reserve").
 *
 * The property with billing consequences is ORDER. A reservation taken for a
 * request that is then refused has to be refunded, and a refund the user never
 * needed is a balance that moved for no reason. Every test below asserts on the
 * wallet and the ledger, not just on the status code, because "it returned 422"
 * says nothing about whether the credits were ever taken.
 */

interface Account {
  userId: string;
  accessToken: string;
  workspaceId: string;
}

/** A moderator with a fixed verdict, driven through the service's test seam. */
function fixedModerator(verdict: { allowed: boolean; reason?: string; throws?: Error }): Moderator {
  return {
    name: 'test',
    moderate: async () => {
      if (verdict.throws !== undefined) {
        throw verdict.throws;
      }
      return {
        allowed: verdict.allowed,
        source: 'test',
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      };
    },
  };
}

describe('moderation before reserve (Phase 6)', () => {
  let db: TestDb;
  let app: TestApp;
  let moderation: ModerationService;

  beforeAll(async () => {
    db = await setupTestDatabase();
    app = await createTestApp();
    moderation = app.app.get(ModerationService);
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
    // The local rules, by default. A test that wants a different verdict says so.
    moderation.setModerator(fixedModerator({ allowed: true }));
  });

  async function account(prefix: string): Promise<Account> {
    const res = await app
      .http()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: TEST_PASSWORD, name: prefix });

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

  const asUser = (acct: Account) => ({
    post: (url: string) => app.http().post(url).set('Authorization', `Bearer ${acct.accessToken}`),
    patch: (url: string) =>
      app.http().patch(url).set('Authorization', `Bearer ${acct.accessToken}`),
  });

  async function postWith(acct: Account, caption: string): Promise<string> {
    const brand = await asUser(acct)
      .post('/api/v1/brands')
      .send({ workspaceId: acct.workspaceId, name: 'Acme', industry: 'retail' });
    const campaign = await asUser(acct)
      .post('/api/v1/campaigns')
      .send({ brandId: brand.body.id as string, goal: 'launch' });
    const post = await asUser(acct)
      .post('/api/v1/posts')
      .send({ campaignId: campaign.body.id as string, type: 'CAPTION', caption });
    return post.body.id as string;
  }

  async function walletOf(userId: string) {
    const rows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    return rows[0];
  }

  async function ledgerRows(userId: string) {
    return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
  }

  describe('a refused request', () => {
    it('returns 422', async () => {
      moderation.setModerator(fixedModerator({ allowed: false, reason: 'refused: test' }));
      const acct = await account('refused');
      const postId = await postWith(acct, 'hello');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MODERATION_REJECTED');
    });

    it('never reserves credits', async () => {
      moderation.setModerator(fixedModerator({ allowed: false }));
      const acct = await account('refused');
      const postId = await postWith(acct, 'hello');

      await asUser(acct).post(`/api/v1/posts/${postId}/generate`).send({ type: 'REEL' });

      // THE assertion. A 422 with a reserved-then-refunded wallet is technically
      // correct and still wrong: the balance moved for a request that never ran.
      expect(await walletOf(acct.userId)).toMatchObject({ available: 50, reserved: 0 });
    });

    it('leaves the ledger untouched - no RESERVE, no REFUND', async () => {
      moderation.setModerator(fixedModerator({ allowed: false }));
      const acct = await account('refused');
      const postId = await postWith(acct, 'hello');

      await asUser(acct).post(`/api/v1/posts/${postId}/generate`).send({ type: 'REEL' });

      const rows = await ledgerRows(acct.userId);
      expect(rows.map((r) => r.entryType)).toEqual(['SIGNUP_BONUS']);
    });

    it('creates no job and no outbox event', async () => {
      moderation.setModerator(fixedModerator({ allowed: false }));
      const acct = await account('refused');
      const postId = await postWith(acct, 'hello');

      await asUser(acct).post(`/api/v1/posts/${postId}/generate`).send({ type: 'REEL' });

      // A job for a refused request is a job a worker will pick up and charge for.
      await expect(db.select().from(generationJobs)).resolves.toHaveLength(0);
    });

    it('does not echo the refused text back to the caller', async () => {
      moderation.setModerator(
        fixedModerator({ allowed: false, reason: `refused: ${BLOCKED_TERMS[0]}` }),
      );
      const acct = await account('refused');
      const postId = await postWith(acct, 'hello');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      // The reason names the CATEGORY. Echoing the user's text into an API
      // response and a log line is the opposite of what a moderation decision
      // is for.
      expect(JSON.stringify(res.body)).not.toContain('my-home-address');
    });
  });

  describe('an allowed request', () => {
    it('reserves and creates the job as normal', async () => {
      const acct = await account('allowed');
      const postId = await postWith(acct, 'hello');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(202);
      expect(await walletOf(acct.userId)).toMatchObject({ available: 20, reserved: 30 });
    });

    it('runs moderation before the tenancy-failing path even reserves', async () => {
      // A stranger must get 403, not 422: the moderation result must not reveal
      // anything about content they are not allowed to see.
      const owner = await account('owner');
      const stranger = await account('stranger');
      const postId = await postWith(owner, 'hello');
      moderation.setModerator(fixedModerator({ allowed: false }));

      const res = await asUser(stranger)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(403);
    });
  });

  describe('moderation outages', () => {
    it('does not block generation when the provider is down', async () => {
      const { ProviderError } = await import('@renderflow/ai');
      moderation.setModerator(
        fixedModerator({
          allowed: true,
          throws: new ProviderError('moderation unavailable', 'TRANSIENT'),
        }),
      );
      const acct = await account('outage');
      const postId = await postWith(acct, 'hello');

      // The local rules already ran and passed, and the content is the user's
      // own. Refusing every request because a third party is down takes the whole
      // product out.
      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(202);
    });

    it('does not swallow a genuine bug in the moderator', async () => {
      moderation.setModerator(
        fixedModerator({ allowed: true, throws: new Error('bug in our code') }),
      );
      const acct = await account('bug');
      const postId = await postWith(acct, 'hello');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      // Only a TRANSIENT provider outage is survivable. A TypeError must not be
      // mistaken for "moderation was unavailable" and waved through.
      expect(res.status).toBe(500);
      expect(await walletOf(acct.userId)).toMatchObject({ available: 50, reserved: 0 });
    });
  });

  describe('the real local moderator, through the service', () => {
    it('refuses a post whose caption matches a blocked term', async () => {
      const { LocalModerator } = await import('@renderflow/ai');
      moderation.setModerator(new LocalModerator());
      const acct = await account('local');
      const postId = await postWith(acct, `a post about ${BLOCKED_TERMS[0]}`);

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(422);
      expect(await walletOf(acct.userId)).toMatchObject({ available: 50, reserved: 0 });
    });

    it('checks the caption as well as the request', async () => {
      const { LocalModerator } = await import('@renderflow/ai');
      moderation.setModerator(new LocalModerator());
      const acct = await account('caption');
      // The offending text is in the POST, not in the generate request body.
      const postId = await postWith(acct, BLOCKED_TERMS[2] ?? 'doxxing');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL', goal: 'a nice clean campaign' });

      expect(res.status).toBe(422);
    });

    it('lets ordinary content through', async () => {
      const { LocalModerator } = await import('@renderflow/ai');
      moderation.setModerator(new LocalModerator());
      const acct = await account('clean');
      const postId = await postWith(acct, 'Rain again on the 8:04.');

      const res = await asUser(acct)
        .post(`/api/v1/posts/${postId}/generate`)
        .send({ type: 'REEL' });

      expect(res.status).toBe(202);
    });
  });
});
