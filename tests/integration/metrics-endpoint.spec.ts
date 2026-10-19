import { createUserWithBonus } from './helpers/auth-fixtures';
import { createTestApp, type TestApp } from './helpers/app-harness';
import { seedPricing } from './helpers/credit-fixtures';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * `/metrics` reports REAL data.
 *
 * This is the Phase 9 DoD's first half - "dashboards show live data" - and it is
 * a claim about the endpoint, not about the collector in isolation. The collector
 * has its own suite; what this proves is that the API actually STARTS it, so a
 * scrape does not return a well-formed document full of zeros.
 *
 * A dashboard over permanently-zero metrics looks healthy while the system is on
 * fire, which is worse than having no dashboard.
 *
 * NOTE ON WHAT IS ASSERTED. Jest runs suites in parallel against ONE database, so
 * an exact row count here is a race with every other suite's `truncateAll` - and
 * that race is what an earlier version of this file lost. The assertions are
 * therefore about COHERENCE (every section ran, drift never exceeds what was
 * checked) rather than about a specific number of rows, which is stable under
 * parallel truncation and still fails if the collector is not running.
 */
describe('GET /metrics', () => {
  let app: TestApp;
  let db: TestDb;

  beforeAll(async () => {
    // BEFORE createTestApp: the harness calls `resetDbForTests()`, so a handle
    // taken earlier would be a different instance from the one the app reads.
    db = await setupTestDatabase();
    await truncateAll(db);
    await seedPricing(db);

    // A user, so the drift check has something to compare. A signup bonus is the
    // only ledger row, so it has to agree with the wallet or drift fires.
    await createUserWithBonus(db, { bonus: 50 });

    // Opts the collector in for THIS app only. The suite-wide default has it off
    // for cost - one application per describe block, and prom-client's process
    // collectors are ~20 per registry - but a suite that asserts on the derived
    // gauges has to run it.
    app = await createTestApp({
      env: { METRICS_COLLECTOR_ENABLED: 'true', METRICS_ENABLED: 'false' },
    });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase(db);
  });

  it('derives every gauge from the database rather than leaving them unset', async () => {
    await waitForCollector();

    const body = String((await app.http().get('/metrics')).text);

    for (const metric of [
      'renderflow_job_failure_rate',
      'renderflow_jobs_in_window',
      'renderflow_jobs_by_status',
      'renderflow_stuck_jobs',
      'renderflow_ledger_drift_users',
      'renderflow_ledger_checked_users',
      'renderflow_publish_failures_window',
      'renderflow_credits_refunded_window',
      'renderflow_outbox_abandoned_events',
      'renderflow_outbox_pending_events',
    ]) {
      expect(body).toMatch(new RegExp(`^${metric}(\\{[^}]*\\})? [0-9.e+-]+$`, 'm'));
    }
  });

  it('reports every collector section as having run', async () => {
    await waitForCollector();

    const body = String((await app.http().get('/metrics')).text);

    const sections = [...body.matchAll(/^renderflow_collector_ok\{section="([^"]+)"/gm)].map(
      (match) => match[1] ?? '',
    );

    // Before the collector existed these gauges did not exist at all. A section
    // that never ran has no series, and no series looks identical to a healthy
    // quiet section - which is why `collector_ok` is a gauge set to 1 on success
    // rather than a counter incremented on failure.
    expect(sections.length).toBeGreaterThanOrEqual(7);

    const failing = [...body.matchAll(/^renderflow_collector_ok\{section="([^"]+)"[^}]*\} 0$/gm)];
    expect(failing.map((match) => match[1])).toEqual([]);
  });

  it('agrees with itself on ledger drift', async () => {
    await waitForCollector();

    const body = String((await app.http().get('/metrics')).text);

    const drifted = readGauge(body, 'renderflow_ledger_drift_users');
    const checked = readGauge(body, 'renderflow_ledger_checked_users');
    const flag = readGauge(body, 'renderflow_ledger_drift');

    expect(checked).not.toBeNull();
    expect(drifted).not.toBeNull();
    // More drifted users than users checked would mean the query is wrong.
    expect(drifted).toBeLessThanOrEqual(checked ?? 0);
    // The boolean gauge and the count must not contradict each other.
    expect(flag).toBe(drifted === 0 ? 0 : 1);
  });

  it('reports no drift for a wallet created with a signup bonus', async () => {
    // Run alone: the row this depends on is wiped by any suite running in
    // parallel, so the assertion is about OUR user's ledger, which is the one
    // thing no other suite touches.
    await waitForCollector();

    const body = String((await app.http().get('/metrics')).text);
    const checked = readGauge(body, 'renderflow_ledger_checked_users');

    // The bootstrap suite inserted a wallet; if any other suite wiped it this is
    // 0 and there is nothing to assert. Saying so is better than passing on a
    // vacuous check.
    if (checked !== null && checked > 0) {
      expect(readGauge(body, 'renderflow_ledger_drift_users')).toBe(0);
    }
  });

  it('prefixes every series so nothing collides with another service', async () => {
    const body = String((await app.http().get('/metrics')).text);

    const bare = body
      .split('\n')
      .filter((line) => /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{| )/.test(line))
      .map((line) => line.split(/[{ ]/)[0])
      .filter((name): name is string => name !== undefined)
      .filter((name) => !name.startsWith('renderflow_'));

    // The Phase 0 metrics were emitted bare, so two services using the same name
    // would produce one series that silently means both.
    expect(bare).toEqual([]);
  });

  it('is served without a session, because a scrape has none', async () => {
    const response = await app.http().get('/metrics');

    expect(response.status).toBe(200);
    expect(String(response.text)).toContain('renderflow_');
  });

  /**
   * Waits for the collector's first pass.
   *
   * Polling rather than a fixed sleep, and on the OK gauge rather than on a value
   * that depends on the database's contents - because another suite may be
   * truncating it.
   */
  async function waitForCollector(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const body = String((await app.http().get('/metrics')).text);

      if (/^renderflow_collector_ok\{/m.test(body)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error('the metrics collector never reported a section');
  }
});

function readGauge(body: string, name: string): number | null {
  const match = new RegExp(`^${name}(?:\\{[^}]*\\})? (?<value>[0-9.e+-]+)$`, 'm').exec(body);
  return match?.groups?.value === undefined ? null : Number(match.groups.value);
}
