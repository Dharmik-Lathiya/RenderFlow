import { sql } from 'drizzle-orm';

import { setupTestDatabase, teardownTestDatabase, type TestDb } from './helpers/test-database';

/**
 * The indexes the Phase 10 review kept, pinned so a migration cannot drop one
 * without a failing test.
 *
 * These are not decorative: each entry is the access path for a query that runs
 * on a page load, a worker poll, or the reaper. The database itself rejects a
 * duplicate claim or a negative wallet, but it will happily execute the same
 * query against a sequential scan, so "the test still passes" is not evidence
 * that the index survived. This suite is.
 */
const REVIEWED_INDEXES = [
  // Credit history and the reserve idempotency lookup.
  'credit_ledger_user_id_created_at_idx',
  // The calendar's date-window read.
  'posts_scheduled_at_idx',
  // Job list by owner, and the reaper's expired-lease sweep.
  'generation_jobs_user_id_created_at_idx',
  'generation_jobs_reclaim_idx',
  // Publisher poll, lease recovery, and a post's full publication history.
  'publish_jobs_due_idx',
  'publish_jobs_reclaim_idx',
  'publish_jobs_post_id_idx',
  // The relay's unpublished-row poll.
  'outbox_events_pending_idx',
  // Unread and recent notifications.
  'notifications_user_id_created_at_idx',
] as const;

describe('reviewed query indexes', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(db);
  });

  it.each(REVIEWED_INDEXES)('keeps %s', async (name) => {
    const result = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${name}
    `);

    expect(result.rows).toEqual([{ indexname: name }]);
  });
});
