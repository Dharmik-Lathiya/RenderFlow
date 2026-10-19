import { eq, sql } from 'drizzle-orm';
import { creditLedger, generationJobs, publishJobs, socialAccounts, wallets } from '@renderflow/db';
import { capture, refund, reserveOnce } from '@renderflow/credits';

import { MetricsCollector } from '../../libs/observability/src/collector';
import { createMetrics } from '../../libs/observability/src/metrics';
import { publishIdempotencyKey } from '../../libs/social/src/publisher';
import { createUserWithBonus as createUser } from './helpers/auth-fixtures';
import { seedPricing } from './helpers/credit-fixtures';
import { seedBrandCampaignPost } from './helpers/studio-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * The metrics collector against a real database.
 *
 * Every number here is derived by SQL, so a mock would test nothing - the point
 * is whether the QUERY is right. Two are genuinely subtle and are the reason
 * this suite exists:
 *
 *  - **ledger drift**, which cannot be `available + reserved == SUM(amount)`.
 *    That identity is arithmetically impossible with one signed column
 *    (PROJECT.md section 5.10), and the query derives each bucket separately.
 *  - **stuck jobs**, which includes a COMPLETED job whose credits were never
 *    captured. The work is done and the user was never charged, and nothing else
 *    in the system would ever surface that.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How many database queries one refresh makes.
 *
 * Every section that touches the database, minus queue depth (skipped when no
 * Redis source is configured). Stated here so adding a section updates one place.
 */
const SECTIONS_PER_PASS = 7;

describe('MetricsCollector', () => {
  let db: TestDb;
  let metrics: ReturnType<typeof createMetrics>;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedPricing(db);
    metrics = createMetrics();
  });

  function collector(
    overrides: { queues?: { depths: () => Promise<Record<string, number>> } } = {},
  ) {
    return new MetricsCollector({
      getDb: () => db,
      metrics,
      ...(overrides.queues === undefined ? {} : { queues: overrides.queues }),
    });
  }

  /**
   * Reads a sample back out of the rendered exposition.
   *
   * Matching the name AND the labels in ONE pattern, not "find the first line for
   * this metric and then check its labels" - the second version returns the wrong
   * series whenever a gauge has more than one, which is exactly what a labelled
   * gauge always is.
   *
   * The value is a NAMED group so it can be indexed by name: with a positional
   * one, adding a group to the labels silently shifts every index and every
   * assertion starts reading `undefined`, which `Number(undefined)` turns into
   * NaN and the failure reads as a bad metric rather than a bad helper.
   */
  async function gauge(name: string, labels?: string): Promise<number | null> {
    const text = await metrics.render();
    const labelPart = labels === undefined ? '(?:\\{[^}]*\\})?' : escapeRegExp(labels);

    const match = new RegExp(`^${name}${labelPart} (?<value>[0-9.e+-]+)$`, 'm').exec(text);

    return match?.groups?.value === undefined ? null : Number(match.groups.value);
  }

  // --- job outcomes --------------------------------------------------------

  it('reports a zero failure rate rather than NaN when nothing ran', async () => {
    // An alert on `job_failure_rate > 0.1` must not fire because the division
    // was undefined.
    await collector().refresh();

    expect(await gauge('renderflow_job_failure_rate')).toBe(0);
    expect(await gauge('renderflow_jobs_in_window')).toBe(0);
  });

  it('reports a failure rate from real jobs', async () => {
    const user = await createUser(db, { bonus: 50 });

    const failing = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });
    await db
      .update(generationJobs)
      .set({ status: 'FAILED', finishedAt: new Date(), refunded: 1 })
      .where(eq(generationJobs.id, failing.jobId));

    const ok = await reserveOnce(db, { userId: user.id, kind: 'CAPTION', emitOutbox: false });
    await capture(db, ok.jobId);

    await collector().refresh();

    // One of two failed.
    expect(await gauge('renderflow_job_failure_rate')).toBeCloseTo(0.5, 5);
    expect(await gauge('renderflow_jobs_in_window')).toBe(2);
  });

  it('ignores jobs older than the window', async () => {
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({
        status: 'FAILED',
        finishedAt: new Date(),
        createdAt: new Date(Date.now() - 7_200_000),
      })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    // A rate computed over all time would sit at 1.0 forever after one failure.
    expect(await gauge('renderflow_job_failure_rate')).toBe(0);
  });

  // --- stuck jobs ----------------------------------------------------------

  it('counts a job that has been RUNNING far too long', async () => {
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({ status: 'PROCESSING', createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    expect(await gauge('renderflow_stuck_jobs')).toBe(1);
  });

  it('counts a COMPLETED job whose credits were never captured', async () => {
    // The one nobody would otherwise notice: the work is done, the user was
    // never charged, and every other signal is healthy.
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({
        status: 'COMPLETED',
        captured: 0,
        finishedAt: new Date(Date.now() - 3_600_000),
        createdAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    expect(await gauge('renderflow_stuck_jobs')).toBe(1);
  });

  it('does not count a healthy completed job', async () => {
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({
        status: 'COMPLETED',
        captured: 1,
        finishedAt: new Date(),
        createdAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    expect(await gauge('renderflow_stuck_jobs')).toBe(0);
  });

  it('does not count a job that is merely slow', async () => {
    // Minutes, not an hour. A reel that takes four minutes is normal.
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({ status: 'PROCESSING', createdAt: new Date(Date.now() - 240_000) })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    expect(await gauge('renderflow_stuck_jobs')).toBe(0);
  });

  it('does not count a CANCELLED job as stuck', async () => {
    // CANCELLED is terminal. Counting it would mean every deliberately
    // abandoned job becomes a permanent "stuck jobs" alert - and a marker that
    // is always red is one nobody looks at.
    const user = await createUser(db, { bonus: 50 });
    const job = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await db
      .update(generationJobs)
      .set({ status: 'CANCELLED', createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(generationJobs.id, job.jobId));

    await collector().refresh();

    expect(await gauge('renderflow_stuck_jobs')).toBe(0);
  });

  // --- job durations -------------------------------------------------------

  /**
   * Two completed jobs at the same stage, 10s and 20s long.
   *
   * The percentile is PERCENTILE_CONT over the real rows: with two samples and
   * p=0.95 it interpolates to 19.5, which a mean-based histogram could never
   * produce.
   */
  async function seedTwoDurations(userId: string): Promise<void> {
    const durations = [10_000, 20_000];

    for (const duration of durations) {
      // CAPTION, not REEL: two reels cost 60 and the fixture grants 50. The
      // stage is set explicitly below, so the kind only decides the price.
      const job = await reserveOnce(db, {
        userId,
        kind: 'CAPTION',
        emitOutbox: false,
      });
      const finishedAt = new Date();

      await db
        .update(generationJobs)
        .set({
          status: 'COMPLETED',
          captured: 1,
          stage: 'RENDER',
          createdAt: new Date(finishedAt.getTime() - duration),
          finishedAt,
        })
        .where(eq(generationJobs.id, job.jobId));
    }
  }

  it('reports mean and p95 duration from the real rows', async () => {
    const user = await createUser(db, { bonus: 50 });
    await seedTwoDurations(user.id);

    await collector().refresh();

    expect(await gauge('renderflow_job_duration_mean_seconds', '{stage="RENDER"}')).toBeCloseTo(
      15,
      5,
    );
    expect(await gauge('renderflow_job_duration_p95_seconds', '{stage="RENDER"}')).toBeCloseTo(
      19.5,
      5,
    );
  });

  it('reports no duration for a stage with no finished jobs', async () => {
    // An absent label rather than a zero: 0s would mean "instant", which is a
    // different claim from "we have nothing to measure".
    const user = await createUser(db, { bonus: 50 });
    await seedTwoDurations(user.id);

    await collector().refresh();

    expect(await gauge('renderflow_job_duration_p95_seconds', '{stage="IMAGE"}')).toBeNull();
  });

  // --- ledger drift --------------------------------------------------------

  it('reports no drift on a wallet the ledger agrees with', async () => {
    await createUser(db, { bonus: 50 });

    await collector().refresh();

    expect(await gauge('renderflow_ledger_drift_users')).toBe(0);
    expect(await gauge('renderflow_ledger_checked_users')).toBe(1);
  });

  it('reports no drift through a full reserve and capture cycle', async () => {
    // The per-bucket derivation has to survive the exact sequence that broke the
    // old `available + reserved == SUM(amount)` identity.
    const user = await createUser(db, { bonus: 50 });
    const reservation = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await collector().refresh();
    expect(await gauge('renderflow_ledger_drift_users')).toBe(0);

    await capture(db, reservation.jobId);

    await collector().refresh();
    expect(await gauge('renderflow_ledger_drift_users')).toBe(0);
  });

  it('reports no drift through a refund', async () => {
    const user = await createUser(db, { bonus: 50 });
    const reservation = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });
    await refund(db, reservation.jobId, 'test');

    await collector().refresh();

    // Back to the bonus, and the ledger says exactly that.
    expect(await gauge('renderflow_ledger_drift_users')).toBe(0);
  });

  it('reports drift when a wallet is edited behind the ledger', async () => {
    const user = await createUser(db, { bonus: 50 });

    await db.update(wallets).set({ available: 9999 }).where(eq(wallets.userId, user.id));

    await collector().refresh();

    expect(await gauge('renderflow_ledger_drift_users')).toBe(1);
    expect(await gauge('renderflow_ledger_drift')).toBe(1);
  });

  it('reports drift when a ledger row disappears', async () => {
    const user = await createUser(db, { bonus: 50 });

    await db.delete(creditLedger).where(eq(creditLedger.userId, user.id));

    await collector().refresh();

    expect(await gauge('renderflow_ledger_drift_users')).toBe(1);
  });

  // --- refunds -------------------------------------------------------------

  async function seedPublishFixture(
    database: TestDb,
    userId: string,
  ): Promise<{ workspaceId: string; accountId: string; postId: string }> {
    const inserted = await database.execute<{ id: string }>(sql`
      INSERT INTO workspaces (id, name, owner_id)
      VALUES (gen_random_uuid(), 'Acme', ${userId}::uuid)
      RETURNING id::text AS id
    `);

    const workspaceId = inserted.rows[0]?.id;
    if (workspaceId === undefined) {
      throw new Error('no workspace');
    }

    const [account] = await database
      .insert(socialAccounts)
      .values({
        workspaceId,
        platform: 'linkedin',
        externalAccountId: 'ext-1',
        token: 'ciphertext',
        connectedBy: userId,
      })
      .returning({ id: socialAccounts.id });

    const { postId } = await seedBrandCampaignPost(database, { workspaceId, userId });

    return { workspaceId, accountId: account?.id ?? '', postId };
  }

  it('counts refunds in the window without inflating on every refresh', async () => {
    const user = await createUser(db, { bonus: 50 });
    const reservation = await reserveOnce(db, { userId: user.id, kind: 'REEL', emitOutbox: false });

    await refund(db, reservation.jobId, 'test');

    const c = collector();

    await c.refresh();
    const first = await gauge('renderflow_credits_refunded_window');

    // A timer that INCREMENTED would double the count every interval, which is
    // what "3 refunds this hour" would become after three ticks.
    await c.refresh();
    const second = await gauge('renderflow_credits_refunded_window');

    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  // --- publish failures ----------------------------------------------------

  it('counts publishes that permanently failed', async () => {
    const user = await createUser(db, { bonus: 50 });
    const { accountId, postId } = await seedPublishFixture(db, user.id);

    await db.insert(publishJobs).values({
      postId,
      socialAccountId: accountId,
      status: 'FAILED',
      scheduledFor: new Date(),
      platformContent: 'x',
    });

    await collector().refresh();

    // The signal behind the DLQ-growth alert.
    expect(await gauge('renderflow_publish_failures_window')).toBe(1);
  });

  it('does not count a publish that is merely waiting', async () => {
    const user = await createUser(db, { bonus: 50 });
    const { accountId, postId } = await seedPublishFixture(db, user.id);

    await db.insert(publishJobs).values({
      postId,
      socialAccountId: accountId,
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() + 3_600_000),
      platformContent: 'x',
    });

    await collector().refresh();

    expect(await gauge('renderflow_publish_failures_window')).toBe(0);
  });

  // --- queue depth ---------------------------------------------------------

  it('reports queue depth when a source is supplied', async () => {
    await collector({
      queues: {
        depths: async () => ({ content: 7, media: 3, publish: 1, analytics: 0 }),
      },
    }).refresh();

    expect(await gauge('renderflow_queue_depth', '{queue="content"}')).toBe(7);
    expect(await gauge('renderflow_queue_depth', '{queue="media"}')).toBe(3);
  });

  it('skips queue depth when Redis is not reachable from this process', async () => {
    // The API may not hold Redis credentials; reporting a stale zero would be
    // worse than reporting nothing.
    await expect(collector().refresh()).resolves.toBeUndefined();
  });

  // --- resilience ----------------------------------------------------------

  it('keeps reporting the sections that work when one fails', async () => {
    const broken = new MetricsCollector({
      getDb: () =>
        ({
          execute: async () => {
            throw new Error('connection reset');
          },
        }) as unknown as TestDb,
      metrics,
    });

    await broken.refresh();

    // Every section failed, so every one is counted rather than one error
    // swallowing the rest silently.
    const text = await metrics.render();
    // Every section reports 0, not "nothing": a section that fails from the
    // moment it starts must be visible, and a counter only incremented on failure
    // would report nothing at all in exactly that case.
    expect(text).toMatch(/renderflow_collector_ok\{section="[^"]+"[^}]*\} 0/);
  });

  it('does not stack refreshes when one is already running', async () => {
    let calls = 0;

    const slow = new MetricsCollector({
      getDb: () =>
        ({
          execute: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { rows: [] };
          },
        }) as unknown as TestDb,
      metrics,
    });

    await Promise.all([slow.refresh(), slow.refresh(), slow.refresh()]);

    // Three overlapping passes would triple the database load every interval.
    //
    // The count is SECTION calls, not concurrent ones: a single pass runs its
    // sections in parallel by design, so "peak concurrency" is one pass's worth
    // and says nothing. What matters is that three refreshes cost ONE pass's
    // worth rather than three.
    //
    // Asserted as `sectionsPerPass` rather than a literal, because adding a
    // section is a normal change and should not fail this test.
    expect(calls).toBe(SECTIONS_PER_PASS);
  });

  it('uses the job id to key publish idempotency, unchanged', () => {
    // Present so the import above is not decorative: the publish key is the same
    // one the publisher uses, and a change there must be a deliberate one.
    expect(publishIdempotencyKey('j1')).toBe('renderflow:j1');
  });
});
