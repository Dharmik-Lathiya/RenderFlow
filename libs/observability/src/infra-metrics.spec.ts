import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every metric the infrastructure files reference must exist.
 *
 * A Grafana panel pointing at a metric that does not exist renders an empty
 * chart, and an alert on one never fires. Both look identical to "everything is
 * fine", which is the most expensive failure mode an observability stack has: it
 * spends someone's trust while telling them nothing.
 *
 * That is not hypothetical. It happened twice while writing Phase 9 - the
 * dashboard referenced `renderflow_jobs_total` when the metric was emitted BARE
 * as `jobs_total`, and an alert referenced
 * `renderflow_outbox_abandoned_total`, which nothing anywhere had declared. Both
 * would have shipped as a green build.
 *
 * The names are read from the SOURCE rather than from a live registry. The
 * relationship being checked is between two static files, and rendering a
 * registry to discover it means duck-typing prom-client's internals - which
 * broke the first version of this test.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const METRICS_SOURCE = join(__dirname, 'metrics.ts');
const ALERTS = join(REPO_ROOT, 'infra', 'prometheus', 'alerts.yml');
const DASHBOARD_DIR = join(REPO_ROOT, 'infra', 'grafana', 'dashboards');

/** Metric names prom-client supplies itself via `collectDefaultMetrics`. */
const PROCESS_METRICS = new Set([
  'renderflow_process_cpu_seconds_total',
  'renderflow_process_cpu_user_seconds_total',
  'renderflow_process_cpu_system_seconds_total',
  'renderflow_process_cpu_seconds',
  'renderflow_process_resident_memory_bytes',
  'renderflow_process_start_time_seconds',
  'renderflow_process_open_fds',
  'renderflow_process_max_fds',
  'renderflow_nodejs_eventloop_lag_seconds',
  'renderflow_nodejs_eventloop_lag_p99_seconds',
  'renderflow_nodejs_active_handles',
  'renderflow_nodejs_active_handles_total',
  'renderflow_nodejs_heap_size_total_bytes',
  'renderflow_nodejs_heap_size_used_bytes',
  'renderflow_nodejs_heap_size_used_bytes_total',
  'renderflow_nodejs_external_memory_bytes',
  'renderflow_nodejs_heap_space_size_total_bytes',
  'renderflow_nodejs_heap_space_size_used_bytes',
  'renderflow_nodejs_heap_space_size_available_bytes',
  'renderflow_nodejs_version_info',
  'renderflow_nodejs_gc_duration_seconds',
]);

function declaredMetrics(): Set<string> {
  const source = readFileSync(METRICS_SOURCE, 'utf8');
  const names = new Set<string>();

  for (const match of source.matchAll(/\bname:\s*'([a-zA-Z_:][a-zA-Z0-9_:]*)'/g)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }

  return names;
}

function referencedIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/\b(renderflow_[a-z0-9_]+)\b/g)) {
    const name = match[1];
    if (name !== undefined) {
      found.add(name);
    }
  }

  return [...found];
}

describe('metrics referenced by the infrastructure files', () => {
  const declared = declaredMetrics();

  it('finds the metric declarations at all', () => {
    // A regex that silently matches nothing would make every other assertion in
    // this file pass for the wrong reason.
    expect(declared.size).toBeGreaterThan(10);
  });

  it('prefixes every declared metric', () => {
    const bare = [...declared].filter((name) => !name.startsWith('renderflow_'));

    // Only `collectDefaultMetrics` was given a prefix before, so the hand-declared
    // metrics were emitted bare and a dashboard referencing the prefixed name
    // rendered an empty chart.
    expect(bare).toEqual([]);
  });

  it('declares every metric the alert rules reference', () => {
    const referenced = referencedIn(readFileSync(ALERTS, 'utf8'));

    expect(referenced.length).toBeGreaterThan(0);

    const missing = referenced.filter((name) => !declared.has(name) && !PROCESS_METRICS.has(name));

    // An alert on a metric that does not exist NEVER fires, which is worse than
    // having no alert: the rule looks reviewed and says nothing.
    expect(missing).toEqual([]);
  });

  it('declares every metric the dashboards reference', () => {
    const files = readdirSync(DASHBOARD_DIR).filter((file) => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    const missing: string[] = [];

    for (const file of files) {
      const text = readFileSync(join(DASHBOARD_DIR, file), 'utf8');

      for (const name of referencedIn(text)) {
        if (!declared.has(name) && !PROCESS_METRICS.has(name)) {
          missing.push(`${file}: ${name}`);
        }
      }
    }

    // An empty chart looks exactly like a healthy system.
    expect(missing).toEqual([]);
  });

  it('names the three alerts the Phase 9 DoD requires', () => {
    const alerts = readFileSync(ALERTS, 'utf8');

    // "alerts defined for stuck jobs, DLQ growth, ledger drift".
    expect(alerts).toContain('RenderFlowStuckJobs');
    expect(alerts).toMatch(/RenderFlow(PublishFailures|OutboxAbandoned)/);
    expect(alerts).toContain('RenderFlowLedgerDrift');
  });

  it('gives every alert a for: clause', () => {
    const alerts = readFileSync(ALERTS, 'utf8');
    const alertCount = (alerts.match(/^\s+- alert:/gm) ?? []).length;
    const forCount = (alerts.match(/^\s+for:/gm) ?? []).length;

    expect(alertCount).toBeGreaterThan(5);

    // Prometheus scrapes every 15s. An alert with no `for` fires on one slow
    // query, which is how people learn to ignore alerts.
    expect(forCount).toBe(alertCount);
  });
});
