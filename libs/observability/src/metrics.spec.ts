import { RenderFlowMetrics, createMetrics } from './metrics';

describe('RenderFlowMetrics', () => {
  it('exposes the metric names from PROJECT.md section 14', async () => {
    const metrics = createMetrics();
    metrics.jobsTotal.inc({ status: 'COMPLETED' }, 1);
    metrics.jobDurationSeconds.observe({ stage: 'IMAGE' }, 4.2);
    metrics.queueDepth.set({ queue: 'media' }, 7);
    metrics.creditsRefundedTotal.inc({ reason: 'max_attempts' }, 30);
    metrics.setLedgerDrift(true);
    metrics.publishFailuresTotal.inc({ platform: 'LINKEDIN' }, 1);

    const output = await metrics.render();

    expect(output).toContain('jobs_total{status="COMPLETED"} 1');
    expect(output).toContain('job_duration_seconds_count{stage="IMAGE"} 1');
    expect(output).toContain('queue_depth{queue="media"} 7');
    expect(output).toContain('credits_refunded_total{reason="max_attempts"} 30');
    expect(output).toContain('ledger_drift 1');
    expect(output).toContain('publish_failures_total{platform="LINKEDIN"} 1');
  });

  it('exposes ledger drift as a boolean gauge', async () => {
    const metrics = createMetrics();
    metrics.setLedgerDrift(true);
    expect(await metrics.render()).toContain('ledger_drift 1');
    metrics.setLedgerDrift(false);
    expect(await metrics.render()).toContain('ledger_drift 0');
  });

  it('labels job duration by stage', async () => {
    const metrics = createMetrics();
    metrics.jobDurationSeconds.observe({ stage: 'RENDER' }, 30);
    expect(await metrics.render()).toContain('job_duration_seconds_sum{stage="RENDER"} 30');
  });

  it('returns a prometheus-compatible content type', () => {
    expect(createMetrics().contentType).toContain('text/plain');
  });

  it('can be built without default process metrics', async () => {
    const metrics = new RenderFlowMetrics({ enabled: false });
    metrics.jobsTotal.inc({ status: 'FAILED' }, 2);
    const output = await metrics.render();
    expect(output).toContain('jobs_total{status="FAILED"} 2');
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
    a.jobsTotal.inc({ status: 'COMPLETED' }, 5);
    expect(await b.render()).not.toContain('jobs_total{status="COMPLETED"}');
  });

  it('clears metrics between scrapes', async () => {
    const metrics = createMetrics();
    metrics.jobsTotal.inc({ status: 'COMPLETED' }, 1);
    metrics.clear();
    expect(await metrics.render()).not.toContain('jobs_total{status="COMPLETED"} 1');
  });
});
