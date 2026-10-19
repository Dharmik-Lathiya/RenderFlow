import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. PROJECT.md section 14.
 *
 * Each `RenderFlowMetrics` owns a private `Registry` rather than using the global
 * default: registering the same metric name twice throws, and a per-instance
 * registry keeps unit tests independent of each other and of the /metrics route.
 *
 * EVERY name carries the `renderflow_` prefix, including the hand-declared ones.
 * The Phase 0 metrics were emitted bare (`jobs_total`, `queue_depth`) because
 * only `collectDefaultMetrics` was given a prefix, which meant a dashboard
 * referencing `renderflow_jobs_total` rendered an empty chart. Prefixing
 * everything also keeps the series from colliding with another service's.
 *
 * There are no counters for job outcomes, refunds or publish failures, and that
 * is deliberate. A counter incremented in a handler has two problems this system
 * cannot afford: it resets when the process restarts, and it records nothing at
 * all while the process is DOWN - so the dashboard goes blank exactly during the
 * incident it exists for. Those facts are properties of a ROW, so they are
 * derived by `MetricsCollector` as gauges. The three counters that used to sit
 * here were incremented in their own unit test and nowhere else, which is the
 * worst of both: they existed, and they always read zero.
 */

export interface MetricsOptions {
  /** When false, only the render/export methods exist and nothing is collected. */
  enabled?: boolean;
  /** Extra label on every series, e.g. { env: 'staging' }. */
  labels?: Record<string, string>;
}

export class RenderFlowMetrics {
  readonly registry: Registry;

  /** queue_depth{queue} */
  readonly queueDepth: Gauge<'queue'>;
  /** ledger_drift (1 = reconciling, 0 = healthy) */
  readonly ledgerDrift: Gauge<string>;

  // --- Derived gauges (Phase 9) --------------------------------------------
  //
  // These are properties of a ROW, not of a code path, so they are sampled from
  // the database on a timer by `MetricsCollector` rather than incremented at the
  // point of work. A counter incremented in a handler cannot tell you that a job
  // has been stuck for forty minutes in a process that died an hour ago.

  /** Fraction of jobs in the last hour that ended FAILED, 0..1. */
  readonly jobFailureRate: Gauge<string>;
  /** Jobs created in the last hour, any status. */
  readonly jobsInWindow: Gauge<string>;
  /** Jobs in the last hour, by terminal status. */
  readonly jobsByStatus: Gauge<'status'>;
  /**
   * Outbox events the relay has given up on.
   *
   * Derived rather than counted, so it survives a relay restart. An abandoned
   * event is still sitting in `outbox_events` with its attempt count at the
   * limit, and nothing will ever pick it up again on its own.
   */
  readonly outboxAbandonedEvents: Gauge<string>;
  /** Outbox events still waiting to be published. */
  readonly outboxPendingEvents: Gauge<string>;
  /** Mean job duration in seconds, by the stage it stopped in. */
  readonly jobDurationMean: Gauge<'stage'>;
  /**
   * 95th percentile job duration in seconds, by the stage it stopped in.
   *
   * A PERCENTILE computed in SQL, not a prom-client histogram fed by the
   * collector. There was a histogram here, and it was a lie: the collector only
   * has the batch mean, so it observed that mean once per job - every pass.
   * prom-client histograms accumulate, so `_count` grew by the number of jobs
   * every 15 seconds and the buckets described a distribution that never
   * existed. The mean was right by accident (the same value repeated), the
   * percentiles were fiction. A gauge whose value is computed by the query that
   * knows the real distribution is worth more than a histogram-shaped object.
   */
  readonly jobDurationP95: Gauge<'stage'>;
  /**
   * Jobs that reached a terminal state long after they should have.
   *
   * The signal behind the Phase 9 "stuck jobs" alert. Includes a COMPLETED job
   * whose credits were never captured: the work is done and the user was never
   * charged, which is a bug nobody would otherwise notice.
   */
  readonly stuckJobs: Gauge<string>;
  /** Credits refunded in the last hour. A window gauge, not a lifetime counter. */
  readonly creditsRefundedWindow: Gauge<string>;
  /** Users whose wallet disagrees with their ledger. */
  readonly ledgerDriftUsers: Gauge<string>;
  /** Users checked by the last drift pass, for a ratio. */
  readonly ledgerCheckedUsers: Gauge<string>;
  /** Publishes that gave up in the last hour. Drives the DLQ-growth alert. */
  readonly publishFailuresWindow: Gauge<string>;
  /**
   * Whether each collector section succeeded on the LAST pass, 1 or 0.
   *
   * A GAUGE, not a failure counter. A counter is invisible until its first
   * increment, so a collector that fails every time from the moment it starts
   * reports no failures at all - the absence of data looks exactly like health.
   * Setting 1 on success means every section is present on every scrape, and
   * `renderflow_collector_ok == 0` is an alertable condition.
   */
  readonly collectorOk: Gauge<'section'>;

  constructor(options: MetricsOptions = {}) {
    const { enabled = true, labels = {} } = options;
    const shared = { ...labels };

    this.registry = new Registry();

    // prom-client >=15 applies constant labels at the registry, not per metric.
    if (Object.keys(shared).length > 0) {
      this.registry.setDefaultLabels(shared);
    }

    if (enabled) {
      collectDefaultMetrics({ register: this.registry, prefix: 'renderflow_' });
    }

    this.queueDepth = new Gauge({
      name: 'renderflow_queue_depth',
      help: 'Pending BullMQ jobs per queue.',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.ledgerDrift = new Gauge({
      name: 'renderflow_ledger_drift',
      help: 'Non-zero when wallet balances disagree with the credit ledger sum.',
      registers: [this.registry],
    });

    this.jobFailureRate = new Gauge({
      name: 'renderflow_job_failure_rate',
      help: 'Fraction of generation jobs from the last hour that ended FAILED.',
      registers: [this.registry],
    });

    this.jobsInWindow = new Gauge({
      name: 'renderflow_jobs_in_window',
      help: 'Generation jobs created in the last hour, any status.',
      registers: [this.registry],
    });

    this.jobsByStatus = new Gauge({
      name: 'renderflow_jobs_by_status',
      help: 'Generation jobs created in the last hour, by terminal status.',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.outboxAbandonedEvents = new Gauge({
      name: 'renderflow_outbox_abandoned_events',
      help: 'Outbox events past their attempt limit. The relay will never retry these; they need a replay.',
      registers: [this.registry],
    });

    this.outboxPendingEvents = new Gauge({
      name: 'renderflow_outbox_pending_events',
      help: 'Outbox events written but not yet published to a queue.',
      registers: [this.registry],
    });

    this.jobDurationMean = new Gauge({
      name: 'renderflow_job_duration_mean_seconds',
      help: 'Mean generation job duration in seconds, by the stage it stopped in.',
      labelNames: ['stage'] as const,
      registers: [this.registry],
    });

    this.jobDurationP95 = new Gauge({
      name: 'renderflow_job_duration_p95_seconds',
      help: '95th percentile generation job duration in seconds, by the stage it stopped in.',
      labelNames: ['stage'] as const,
      registers: [this.registry],
    });

    this.stuckJobs = new Gauge({
      name: 'renderflow_stuck_jobs',
      help: 'Jobs past every legitimate duration: unfinished after a long time, or finished but never charged.',
      registers: [this.registry],
    });

    this.creditsRefundedWindow = new Gauge({
      name: 'renderflow_credits_refunded_window',
      help: 'Credits refunded in the last hour. A window gauge, not a lifetime counter.',
      registers: [this.registry],
    });

    this.ledgerDriftUsers = new Gauge({
      name: 'renderflow_ledger_drift_users',
      help: 'Users whose wallet balances disagree with their credit ledger.',
      registers: [this.registry],
    });

    this.ledgerCheckedUsers = new Gauge({
      name: 'renderflow_ledger_checked_users',
      help: 'Users examined by the most recent reconciliation pass.',
      registers: [this.registry],
    });

    this.publishFailuresWindow = new Gauge({
      name: 'renderflow_publish_failures_window',
      help: 'Publishes that permanently failed in the last hour.',
      registers: [this.registry],
    });

    this.collectorOk = new Gauge({
      name: 'renderflow_collector_ok',
      help: 'Whether each metrics collection section succeeded on the last pass. 0 means stale gauges for that section.',
      labelNames: ['section'] as const,
      registers: [this.registry],
    });
  }

  /** Convenience: set ledger drift to 0/1 from a reconciliation result. */
  setLedgerDrift(drifted: boolean): void {
    this.ledgerDrift.set(drifted ? 1 : 0);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Reset every series; used by tests and admin tooling between scrapes. */
  clear(): void {
    this.registry.resetMetrics();
  }
}

export function createMetrics(options?: MetricsOptions): RenderFlowMetrics {
  return new RenderFlowMetrics(options);
}
