import { eq, inArray, sql } from 'drizzle-orm';
import { QUEUE_NAMES, queueForJobStage, type QueueName } from '@renderflow/common';
import { outboxEvents, type Database, type DbTransaction } from '@renderflow/db';

/**
 * The outbox relay (PROJECT.md section 6 and 9, AGENTS.md rule 6: "No direct
 * queue pushes from request handlers after a DB write").
 *
 * A request handler writes state and an `outbox_events` row in ONE transaction.
 * This relay then publishes those rows to the queue and marks them processed. The
 * consequence is that a crash between commit and publish cannot lose an event:
 * the row is still sitting there, unprocessed, on the next poll.
 *
 * The publisher is an interface rather than BullMQ directly. Two reasons: the
 * relay's real behaviour - ordering, marking processed, retry accounting - is
 * worth testing without a Redis, and AGENTS.md section 8 asks for exactly this
 * shape for every other integration.
 */

export interface PublishMessage {
  /** Stable queue name, typed so a publisher cannot be handed a typo. */
  queue: QueueName;
  /** Deterministic id, so a republished event cannot double-enqueue. */
  jobId: string;
  payload: Record<string, unknown>;
}

export interface JobPublisher {
  publish(message: PublishMessage): Promise<void>;
}

export interface OutboxRelayOptions {
  /** Rows per poll. Small so a burst is picked up promptly. */
  batchSize?: number;
  /** Delay between empty polls. */
  pollIntervalMs?: number;
  /** Max attempts before an event is left for a human to look at. */
  maxAttempts?: number;
  /** Injectable clock so tests do not sleep. */
  now?: () => number;
}

export interface RelayOutcome {
  published: number;
  failed: number;
  /** Events that have exceeded `maxAttempts` and are no longer retried. */
  abandoned: number;
}

/**
 * The library's own fallbacks, for callers that pass no options (tests, and any
 * embedder without `@renderflow/queue` config). Production values come from
 * `loadQueueConfig()` and are overridable per environment, so a deployment can
 * trade relay latency against database load without a code change.
 */
const DEFAULTS = {
  batchSize: 50,
  pollIntervalMs: 1_000,
  maxAttempts: 10,
};

/**
 * Which queue an event belongs to.
 *
 * `job.created` opens a job on the content queue. `job.stage_completed` is the
 * hand-off: it routes to the queue that owns the stage, which is how a reel
 * crosses from content-worker to media-worker without either app knowing about
 * the other. An event we cannot route falls back to `content` rather than being
 * dropped - a misrouted event is a bug, a dropped one is a job that never
 * finishes with credits still reserved.
 */
export function queueForEvent(eventType: string, payload?: Record<string, unknown>): QueueName {
  switch (eventType) {
    case 'job.created':
      return QUEUE_NAMES.CONTENT;
    case 'job.stage_completed': {
      const stage = typeof payload?.stage === 'string' ? payload.stage : undefined;
      return (stage === undefined ? null : queueForJobStage(stage)) ?? QUEUE_NAMES.CONTENT;
    }
    case 'post.publish_failed':
      return QUEUE_NAMES.NOTIFICATIONS;
    default:
      return QUEUE_NAMES.CONTENT;
  }
}

interface OutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Publishes every unprocessed outbox event, oldest first.
 *
 * Delivery here is AT LEAST ONCE, and it is worth being precise about why,
 * because the obvious design gets it wrong:
 *
 * `FOR UPDATE SKIP LOCKED` stops two relays from grabbing the same row *while
 * both are inside the claim transaction*. It does not reserve the row afterwards.
 * The claim commits, and only then does the relay publish and mark the row
 * processed - a window in which a second relay's poll sees the row as still
 * pending and publishes it again. Widening the transaction to close that window
 * would mean holding a database transaction open across a call to Redis, which
 * AGENTS.md forbids outright.
 *
 * So the duplicate is real, and the design leans on the deterministic job id
 * instead: `generation:<aggregateId>` is the same for both publishes, and BullMQ
 * drops the second add. Exactly-once *enqueue* comes from the id, not from the
 * lock. `InMemoryPublisher` therefore dedupes on jobId too, so a test measures
 * the behaviour production actually has.
 *
 * Returns rather than looping, so a caller decides the cadence - and a test can
 * drive it one tick at a time.
 */
export async function relayOnce(
  db: Database,
  publisher: JobPublisher,
  options: OutboxRelayOptions = {},
): Promise<RelayOutcome> {
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const now = options.now ?? Date.now;

  // Partitioning the work between concurrent relays. AGENTS.md section 7 asks
  // for SKIP LOCKED on queue-like table polling, and this is that. See the note
  // above: it spreads the load, it does not reserve the rows.
  const claimed = await db.transaction(async (tx: DbTransaction) => {
    const rows = await tx.execute<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(sql`
      SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
      FROM outbox_events
      WHERE processed_at IS NULL AND attempts < ${maxAttempts}
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `);

    if (rows.rows.length > 0) {
      // Claim them by stamping the attempt count, so a relay that dies mid-batch
      // does not leave them looking untouched. Built with `inArray` rather than
      // a hand-rolled `sql.join`, which splices the values into a single comma
      // separated parameter instead of a list.
      await tx
        .update(outboxEvents)
        .set({ attempts: sql`${outboxEvents.attempts} + 1` })
        .where(
          inArray(
            outboxEvents.id,
            rows.rows.map((row) => row.id),
          ),
        );
    }

    return rows.rows.map((row): OutboxRow => ({
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
    }));
  });

  let published = 0;
  let failed = 0;

  for (const event of claimed) {
    try {
      await publisher.publish({
        queue: queueForEvent(event.eventType, event.payload),
        // Deterministic, so republishing after a crash between publish and
        // mark-processed cannot enqueue the same work twice.
        jobId: `generation:${event.aggregateId}`,
        payload: event.payload,
      });

      await db
        .update(outboxEvents)
        .set({ processedAt: new Date(now()) })
        .where(eq(outboxEvents.id, event.id));

      published += 1;
    } catch {
      // Left unprocessed with an incremented attempt count, so the next poll
      // retries it. Swallowing the error is the point: one bad event must not
      // stop the relay draining the rest of the batch.
      failed += 1;
    }
  }

  const abandoned = await countAbandoned(db, maxAttempts);

  return { published, failed, abandoned };
}

/** Events that have been retried past the limit and now need a human. */
export async function countAbandoned(
  db: Database,
  maxAttempts = DEFAULTS.maxAttempts,
): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM outbox_events
    WHERE processed_at IS NULL AND attempts >= ${maxAttempts}
  `);
  return Number(rows.rows[0]?.n ?? '0');
}

/** Events still waiting to be published. */
export async function countPending(db: Database): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM outbox_events WHERE processed_at IS NULL`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

/**
 * Polls until stopped.
 *
 * `run()` is what `apps/outbox-relay` calls; `relayOnce` is what a test calls.
 * Splitting them is what makes the loop testable without a timer.
 */
export class OutboxRelay {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly publisher: JobPublisher,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    const interval = this.options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;

    while (!signal.aborted && this.running) {
      const outcome = await relayOnce(this.db, this.publisher, this.options);

      if (outcome.published === 0 && outcome.failed === 0) {
        await sleep(interval);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Records for tests and for the in-memory publisher.
 *
 * Kept in this module rather than in tests so `apps/outbox-relay` can be run
 * against a local development setup without Redis.
 *
 * Deduplicates on `queue + jobId`, exactly as BullMQ does. A publisher that
 * recorded every call would let a test pass on a claim that production does not
 * make: the relay's guarantee is at-least-once delivery plus a deterministic job
 * id, and a double that this class silently hides is the double BullMQ hides
 * too. `calls` still records every attempt, so a test can assert on the
 * duplicates rather than only on the enqueued set.
 *
 * The queue is part of the key because BullMQ scopes job ids per queue - and it
 * has to be. A reel's stages route to `content` and then to `media`, all keyed on
 * `generation:<jobId>`; deduping on the id alone would swallow the very hand-off
 * that lets media-worker ever run.
 */
export class InMemoryPublisher implements JobPublisher {
  /** Every publish call, including ones a deduplicating queue would drop. */
  readonly calls: PublishMessage[] = [];
  /** What actually reached the queue, i.e. BullMQ's view after id dedupe. */
  readonly published: PublishMessage[] = [];

  private readonly seen = new Set<string>();
  private failuresRemaining = 0;

  /** Makes the next `n` publishes throw, to exercise the retry path. */
  failNext(n: number): void {
    this.failuresRemaining = n;
  }

  publish(message: PublishMessage): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error('publish failed'));
    }

    this.calls.push(message);

    const key = `${message.queue}:${message.jobId}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.published.push(message);
    }

    return Promise.resolve();
  }
}
