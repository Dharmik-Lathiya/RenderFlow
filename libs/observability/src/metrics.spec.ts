import { RenderFlowMetrics, createMetrics } from './metrics';

/**
 * The exposition itself.
 *
 * These assertions are on the RENDERED text, not on the objects, because the
 * whole failure mode being guarded against is a metric that exists in TypeScript
 * and never appears in a scrape - which a test that checks `metric.get()` cannot
 * distinguish from a metric working.
 */
describe('RenderFlowMetrics', () => {
  it('prefixes every hand-declared metric, not just the default ones', async () => {
    const metrics = createMetrics();
    metrics.jobDurationMean.set({ stage: 'IMAGE' }, 4.2);
    metrics.queueDepth.set({ queue: 'media' }, 7);

    const output = await metrics.render();

    // The Phase 0 metrics were emitted BARE, because only
    // `collectDefaultMetrics` was given a prefix. A dashboard referencing
    // `renderflow_queue_depth` rendered an empty chart against a real metric
    // called `queue_depth`.
    expect(output).toContain('renderflow_job_duration_mean_seconds{stage="IMAGE"} 4.2');
    expect(output).toContain('renderflow_queue_depth{queue="media"} 7');

    // No bare series may survive: they collide with any other service that ever
    // uses the same name.
    expect(output).not.toMatch(/^queue_depth/m);
    expect(output).not.toMatch(/^job_duration_mean_seconds/m);
  });

  it('exposes the derived gauges the collector sets', async () => {
    const metrics = createMetrics();

    metrics.jobFailureRate.set(0.25);
    metrics.jobsInWindow.set(40);
    metrics.jobsByStatus.set({ status: 'FAILED' }, 10);
    metrics.jobDurationMean.set({ stage: 'RENDER' }, 31.5);
    metrics.jobDurationP95.set({ stage: 'RENDER' }, 94.25);
    metrics.stuckJobs.set(3);
    metrics.creditsRefundedWindow.set(12);
    metrics.ledgerDriftUsers.set(1);
    metrics.ledgerCheckedUsers.set(500);
    metrics.outboxAbandonedEvents.set(2);
    metrics.outboxPendingEvents.set(9);
    metrics.publishFailuresWindow.set(4);
    metrics.collectorOk.set({ section: 'outbox health' }, 1);
    metrics.collectorOk.set({ section: 'ledger drift' }, 0);

    const output = await metrics.render();

    for (const expected of [
      'renderflow_job_failure_rate 0.25',
      'renderflow_jobs_in_window 40',
      'renderflow_jobs_by_status{status="FAILED"} 10',
      'renderflow_job_duration_mean_seconds{stage="RENDER"} 31.5',
      'renderflow_job_duration_p95_seconds{stage="RENDER"} 94.25',
      'renderflow_stuck_jobs 3',
      'renderflow_credits_refunded_window 12',
      'renderflow_ledger_drift_users 1',
      'renderflow_ledger_checked_users 500',
      'renderflow_outbox_abandoned_events 2',
      'renderflow_outbox_pending_events 9',
      'renderflow_publish_failures_window 4',
      'renderflow_collector_ok{section="outbox health"} 1',
      'renderflow_collector_ok{section="ledger drift"} 0',
    ]) {
      expect(output).toContain(expected);
    }
  });

  it('exposes ledger drift as a boolean gauge', async () => {
    const metrics = createMetrics();

    metrics.setLedgerDrift(true);
    expect(await metrics.render()).toContain('renderflow_ledger_drift 1');

    metrics.setLedgerDrift(false);
    expect(await metrics.render()).toContain('renderflow_ledger_drift 0');
  });

  it('returns a prometheus-compatible content type', () => {
    expect(createMetrics().contentType).toContain('text/plain');
  });

  it('can be built without default process metrics', async () => {
    const metrics = new RenderFlowMetrics({ enabled: false });
    metrics.queueDepth.set({ queue: 'publish' }, 2);

    const output = await metrics.render();

    // The hand-declared series survive `enabled: false`; only prom-client's
    // process metrics are omitted, because `enabled` controls the default set.
    expect(output).toContain('renderflow_queue_depth{queue="publish"} 2');
    expect(output).not.toContain('renderflow_process_cpu');
  });

  it('tags every series with configured labels', async () => {
    const metrics = createMetrics({ labels: { env: 'test' } });
    metrics.queueDepth.set({ queue: 'publish' }, 1);
    expect(await metrics.render()).toContain('env="test"');
  });

  it('keeps instances independent so tests cannot leak into each other', async () => {
    const a = createMetrics();
    const b = createMetrics();

    a.queueDepth.set({ queue: 'content' }, 5);

    expect(await b.render()).not.toContain('renderflow_queue_depth{queue="content"}');
  });

  it('clears metrics between scrapes', async () => {
    const metrics = createMetrics();
    metrics.queueDepth.set({ queue: 'content' }, 5);

    metrics.clear();

    expect(await metrics.render()).not.toContain('renderflow_queue_depth{queue="content"}');
  });
});
