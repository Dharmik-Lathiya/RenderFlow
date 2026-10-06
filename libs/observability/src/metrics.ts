import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. PROJECT.md section 14.
 *
 * Each `RenderFlowMetrics` owns a private `Registry` rather than using the global
 * default: registering the same metric name twice throws, and a per-instance
 * registry keeps unit tests independent of each other and of the /metrics route.
 */

export interface MetricsOptions {
  /** When false, only the render/export methods exist and nothing is collected. */
  enabled?: boolean;
  /** Extra label on every series, e.g. { env: 'staging' }. */
  labels?: Record<string, string>;
}

export class RenderFlowMetrics {
  readonly registry: Registry;

  /** jobs_total{status} */
  readonly jobsTotal: Counter<'status'>;
  /** job_duration_seconds{stage} */
  readonly jobDurationSeconds: Histogram<'stage'>;
  /** queue_depth{queue} */
  readonly queueDepth: Gauge<'queue'>;
  /** credits_refunded_total{reason} */
  readonly creditsRefundedTotal: Counter<'reason'>;
  /** ledger_drift (1 = reconciling, 0 = healthy) */
  readonly ledgerDrift: Gauge<string>;
  /** publish_failures_total{platform} */
  readonly publishFailuresTotal: Counter<'platform'>;

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

    this.jobsTotal = new Counter({
      name: 'jobs_total',
      help: 'Generation jobs by terminal status.',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.jobDurationSeconds = new Histogram({
      name: 'job_duration_seconds',
      help: 'Wall-clock seconds spent in each generation stage.',
      labelNames: ['stage'] as const,
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [this.registry],
    });

    this.queueDepth = new Gauge({
      name: 'queue_depth',
      help: 'Pending BullMQ jobs per queue.',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.creditsRefundedTotal = new Counter({
      name: 'credits_refunded_total',
      help: 'Credits returned to wallets, by reason.',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.ledgerDrift = new Gauge({
      name: 'ledger_drift',
      help: 'Non-zero when wallet balances disagree with the credit ledger sum.',
      registers: [this.registry],
    });

    this.publishFailuresTotal = new Counter({
      name: 'publish_failures_total',
      help: 'Publish failures by social platform.',
      labelNames: ['platform'] as const,
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
