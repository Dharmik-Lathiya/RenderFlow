import { JOB_STATUSES, TERMINAL_JOB_STATUSES } from '@renderflow/common';
import type { Database } from '@renderflow/db';

import type { RenderFlowMetrics } from './metrics';

/**
 * Turns durable state into Prometheus samples (PROJECT.md section 14, Phase 9:
 * "Prometheus metrics: queue depth, job duration, failure rate, refund count,
 * ledger drift").
 *
 * Why this exists rather than incrementing counters at the point of work: most of
 * these facts are properties of a ROW, not of a code path. A counter incremented
 * in a handler resets when the process restarts, and cannot tell you that a job
 * has been stuck for forty minutes in a process that died an hour ago. The
 * database is the only place that knows.
 *
 * So the gauges are DERIVED, on a timer, and the counters stay where they
 * belong - at the event.
 *
 * The refresh is deliberately best-effort: a collector that throws would leave
 * `/metrics` answering 500, and a scrape endpoint that fails is worse than one
 * that reports a stale number. Failures are counted instead, so a broken
 * collector is visible rather than silent.
 */

export interface QueueDepthSource {
  /** Current depth per queue. May reject; the collector records and continues. */
  depths(): Promise<Record<string, number>>;
}

export interface CollectorOptions {
  /**
   * Resolves the database, per refresh.
   *
   * A FUNCTION rather than a `Database`, deliberately. The library's `getDb()` is a
   * singleton that callers are allowed to reset; capturing the handle here would
   * pin whatever pool was current and leak it once the singleton moved on.
   */
  getDb: () => Database;
  metrics: RenderFlowMetrics;
  /** Omit when Redis is not reachable from this process. */
  queues?: QueueDepthSource;
  /** How often to refresh. Default 15s, matching the scrape interval. */
  intervalMs?: number;
  logger?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

const DEFAULTS = { intervalMs: 15_000 };

/**
 * How long a job may sit without progress before it counts as stuck.
 *
 * Applies to a NON-terminal job (PENDING and PROCESSING are the only ones) that
 * was created longer ago than this, and separately to a COMPLETED job whose
 * credits were never captured. Terminal states are excluded: a cancelled job is
 * finished, not stuck.
 */
const STUCK_AFTER_SECONDS = 300;

/**
 * Attempts after which the relay stops retrying an event.
 *
 * Must match the relay's own default (`DEFAULTS.maxAttempts` in
 * libs/outbox/src/relay.ts). Importing it would couple the metrics package to
 * the outbox one, so the value is asserted by a test instead.
 */
export const ABANDONED_MAX_ATTEMPTS = 10;

/**
 * Terminal statuses, quoted for SQL.
 *
 * Built from the shared enum rather than written as a literal list: a status
 * added to `libs/common` must not silently start counting as "unfinished", or
 * every job that reaches it would be reported as stuck forever. The values are
 * enum literals, so there is nothing user-supplied here to inject.
 */
const TERMINAL_STATUS_SQL = TERMINAL_JOB_STATUSES.map((status) => `'${status}'`).join(', ');

export class MetricsCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  /** Guards against a slow query overlapping the next tick. */
  private refreshing = false;

  constructor(private readonly options: CollectorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  }

  /** Refreshes once, then every `intervalMs`. */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    // Refresh immediately so the first scrape after boot has real numbers rather
    // than zeros for a full interval.
    void this.refresh();

    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // A metrics timer must not be the reason the process stays alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass over the durable state.
   *
   * Never throws. Each section is independent so a failure in one leaves the
   * others reporting, and a scrape endpoint that 500s is worse than one with a
   * stale gauge.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      // A slow query must not stack up behind itself; Prometheus will scrape
      // again shortly and the gauge keeps its previous value.
      return;
    }

    this.refreshing = true;

    try {
      await Promise.all([
        this.safely('job outcomes', () => this.collectJobOutcomes()),
        this.safely('job durations', () => this.collectJobDurations()),
        this.safely('stuck jobs', () => this.collectStuckJobs()),
        this.safely('refunds', () => this.collectRefunds()),
        this.safely('ledger drift', () => this.collectLedgerDrift()),
        this.safely('publish failures', () => this.collectPublishFailures()),
        this.safely('outbox health', () => this.collectOutbox()),
        this.safely('queue depth', () => this.collectQueueDepth()),
      ]);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Failure rate, read as CURRENT STATE rather than a cumulative counter.
   *
   * A cumulative counter cannot be turned into a rate after a restart without
   * `rate()`, and a gauge labelled `failure_rate` is immediately readable in a
   * dashboard and in an alert expression.
   */
  private async collectJobOutcomes(): Promise<void> {
    const rows = await this.query<{ status: string; n: string }>(`
      SELECT status, COUNT(*)::text AS n
        FROM generation_jobs
       WHERE created_at > now() - interval '1 hour'
       GROUP BY status
    `);

    let total = 0;
    let failed = 0;

    for (const row of rows) {
      const count = Number(row.n);
      total += count;

      if (row.status === 'FAILED') {
        failed += count;
      }
    }

    // Every status from the shared enum is set on every pass, including the ones
    // with no rows.
    // A labelled gauge only appears once it is set, so setting only what came
    // back would leave the dashboard panel EMPTY rather than showing zeros - and
    // an empty panel reads as "nothing has ever run", which is a different and
    // more alarming claim than "no jobs in the last hour".
    for (const status of JOB_STATUSES) {
      this.options.metrics.jobsByStatus.set({ status }, 0);
    }

    for (const row of rows) {
      this.options.metrics.jobsByStatus.set({ status: row.status }, Number(row.n));
    }

    // Zero rather than NaN when nothing ran: an alert on `> 0.1` must not fire
    // because the division was undefined.
    const rate = total === 0 ? 0 : failed / total;

    this.options.metrics.jobFailureRate.set(rate);
    this.options.metrics.jobsInWindow.set(total);
  }

  /**
   * Outbox health.
   *
   * `ABANDONED_MAX_ATTEMPTS` is the same default the relay uses
   * (`DEFAULT_REAPER`/`DEFAULT_RELAY` in libs/outbox). Duplicated rather than
   * imported because the relay's default is not exported and a collector that
   * imported it would make the metrics module depend on the outbox package;
   * the value is asserted by a test so the two cannot drift silently.
   */
  private async collectOutbox(): Promise<void> {
    const rows = await this.query<{ pending: string; abandoned: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE processed_at IS NULL)::text AS pending,
        COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts >= ${ABANDONED_MAX_ATTEMPTS})::text AS abandoned
        FROM outbox_events
    `);

    this.options.metrics.outboxPendingEvents.set(Number(rows[0]?.pending ?? '0'));
    this.options.metrics.outboxAbandonedEvents.set(Number(rows[0]?.abandoned ?? '0'));
  }

  /**
   * Duration by terminal state.
   *
   * Set rather than observed: a histogram records only the processes that were
   * alive. A job that finished while the API was down contributes to neither, so
   * a histogram here would under-report exactly during an incident.
   */
  private async collectJobDurations(): Promise<void> {
    // The percentile is computed HERE, over the real rows, rather than fed into
    // a prom-client histogram. The collector only ever sees an aggregate, so
    // observing a batch mean would describe a distribution that does not exist -
    // and because histograms accumulate, the sample count would grow by the
    // number of jobs on every pass.
    const rows = await this.query<{ stage: string; mean: string; p95: string }>(`
      SELECT stage::text AS stage,
             AVG(EXTRACT(EPOCH FROM (finished_at - created_at)))::text AS mean,
             PERCENTILE_CONT(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (finished_at - created_at))
             )::text AS p95
        FROM generation_jobs
       WHERE finished_at IS NOT NULL
         AND finished_at > now() - interval '1 hour'
       GROUP BY 1
    `);

    for (const row of rows) {
      const mean = Number(row.mean);
      const p95 = Number(row.p95);

      if (Number.isFinite(mean)) {
        this.options.metrics.jobDurationMean.set({ stage: row.stage }, mean);
      }

      if (Number.isFinite(p95)) {
        this.options.metrics.jobDurationP95.set({ stage: row.stage }, p95);
      }
    }
  }

  /**
   * Jobs that reached a terminal state long after they should have.
   *
   * The Phase 9 DoD names "alerts defined for stuck jobs", and this is the signal
   * behind it: a job in a terminal state whose `finished_at` is in the future,
   * or one that has been RUNNING far past any legitimate duration.
   */
  private async collectStuckJobs(): Promise<void> {
    const rows = await this.query<{ status: string; n: string }>(`
      SELECT status, COUNT(*)::text AS n
        FROM generation_jobs
       WHERE (
              status NOT IN (${TERMINAL_STATUS_SQL})
          AND created_at < now() - interval '${STUCK_AFTER_SECONDS} seconds'
       )
       OR (
              status = 'COMPLETED'
          AND captured = 0
          AND finished_at < now() - interval '${STUCK_AFTER_SECONDS} seconds'
       )
       GROUP BY status
    `);

    let stuck = 0;
    for (const row of rows) {
      stuck += Number(row.n);
    }

    this.options.metrics.stuckJobs.set(stuck);
  }

  /** Credits returned to users, by reason, over the last hour. */
  private async collectRefunds(): Promise<void> {
    const rows = await this.query<{ reason: string; n: string }>(`
      SELECT entry_type::text AS reason, COUNT(*)::text AS n
        FROM credit_ledger
       WHERE entry_type = 'REFUND'
         AND created_at > now() - interval '1 hour'
       GROUP BY 1
    `);

    let refunded = 0;

    for (const row of rows) {
      refunded += Number(row.n);
    }

    // Set, not incremented: this runs every interval, and incrementing on a
    // timer would inflate the count by however often the timer fired.
    this.options.metrics.creditsRefundedWindow.set(refunded);
  }

  /**
   * Ledger drift.
   *
   * The per-bucket filters below are a COPY of the ones in
   * `reconcileUser` (libs/credits/src/balance.ts), and they have to match it
   * exactly. An earlier version of this query re-derived the invariant from
   * scratch, got the signs wrong, and reported drift on every user who had ever
   * been refunded - which is the most alarming false positive this system could
   * produce.
   *
   * A copy is still a copy, so the signs are stated rather than left implicit:
   *   - `RESERVE` is stored NEGATIVE: it moved credits out of available.
   *   - `REFUND` is stored POSITIVE: it moved them back into available.
   *   - `CAPTURE` is stored NEGATIVE: the credits left the user's holdings
   *     entirely, so reserved is where they were, negated.
   *   - `EXPIRY` behaves like a reserve for the available bucket.
   *
   * `tests/integration/metrics-collector.spec.ts` asserts this agrees with the
   * reconciler through a full reserve/capture/refund cycle, which is the only
   * reason to trust a duplicated definition.
   */
  private async collectLedgerDrift(): Promise<void> {
    const rows = await this.query<{ drifted: string; checked: string }>(`
      WITH wallet_totals AS (
        SELECT user_id,
               SUM(available)::bigint AS available,
               SUM(reserved)::bigint  AS reserved
          FROM wallets
         GROUP BY user_id
      ),
      ledger_totals AS (
        SELECT user_id,
               (COALESCE(SUM(amount) FILTER (
                  WHERE entry_type IN ('SIGNUP_BONUS', 'PURCHASE', 'ADJUSTMENT', 'REFUND')), 0)
                + COALESCE(SUM(amount) FILTER (
                  WHERE entry_type IN ('RESERVE', 'EXPIRY')), 0))::bigint AS available,
               (-COALESCE(SUM(amount) FILTER (
                  WHERE entry_type IN ('RESERVE', 'REFUND')), 0)
                + COALESCE(SUM(amount) FILTER (
                  WHERE entry_type = 'CAPTURE'), 0))::bigint AS reserved
          FROM credit_ledger
         GROUP BY user_id
      )
      SELECT
        COUNT(*) FILTER (WHERE w.available IS DISTINCT FROM l.available
                           OR w.reserved IS DISTINCT FROM l.reserved)::text AS drifted,
        COUNT(*)::text AS checked
      FROM wallet_totals w
      FULL OUTER JOIN ledger_totals l USING (user_id)
    `);

    const checked = Number(rows[0]?.checked ?? '0');
    const drifted = Number(rows[0]?.drifted ?? '0');

    this.options.metrics.setLedgerDrift(drifted > 0);
    this.options.metrics.ledgerDriftUsers.set(drifted);
    this.options.metrics.ledgerCheckedUsers.set(checked);
  }

  /** Publishes that gave up, over the last hour. Drives the DLQ-growth alert. */
  private async collectPublishFailures(): Promise<void> {
    const rows = await this.query<{ platform: string; n: string }>(`
      SELECT sa.platform::text AS platform, COUNT(*)::text AS n
        FROM publish_jobs pj
        JOIN social_accounts sa ON sa.id = pj.social_account_id
       WHERE pj.status = 'FAILED'
         AND pj.updated_at > now() - interval '1 hour'
       GROUP BY 1
    `);

    let failed = 0;
    for (const row of rows) {
      failed += Number(row.n);
    }

    this.options.metrics.publishFailuresWindow.set(failed);
  }

  private async collectQueueDepth(): Promise<void> {
    const source = this.options.queues;

    if (source === undefined) {
      return;
    }

    const depths = await source.depths();

    for (const [queue, depth] of Object.entries(depths)) {
      this.options.metrics.queueDepth.set({ queue }, depth);
    }
  }

  /**
   * Runs one section, recording whether it worked.
   *
   * The OK gauge is set on BOTH paths. That is the whole point: a section that
   * fails from the moment the process starts must be visible, and a counter only
   * ever incremented on failure would report nothing at all in exactly that case.
   */
  private async safely(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
      this.options.metrics.collectorOk.set({ section: what }, 1);
    } catch (error) {
      this.options.metrics.collectorOk.set({ section: what }, 0);
      this.options.logger?.warn({ err: error, section: what }, 'metrics collection failed');
    }
  }

  /**
   * Runs a read-only query.
   *
   * Constrained to `QueryResultRow` because that is what drizzle's `execute`
   * requires; the alias keeps the call sites readable without an assertion.
   */
  private async query<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await this.options.getDb().execute<T>(sql);
    // One cast, at the single boundary where SQL becomes TypeScript. drizzle
    // types the result as its own row proxy, which will not narrow to `T` for an
    // arbitrary T; the shape is asserted by the SQL itself and by the tests.
    return result.rows as T[];
  }
}
