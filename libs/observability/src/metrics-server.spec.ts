import { createMetrics } from './metrics';
import { readMetricsPort, startMetricsServer } from './metrics-server';

describe('startMetricsServer', () => {
  it('serves Prometheus text on /metrics and closes cleanly', async () => {
    const metrics = createMetrics({ enabled: false });
    const server = await startMetricsServer({ port: 0, metrics, host: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('renderflow_stuck_jobs');
    } finally {
      await server.close();
    }
  });

  it('exposes liveness and rejects everything else', async () => {
    const metrics = createMetrics({ enabled: false });
    const server = await startMetricsServer({ port: 0, metrics, host: '127.0.0.1' });

    try {
      const live = await fetch(`${server.url}/health/live`);
      expect(live.status).toBe(200);

      const missing = await fetch(`${server.url}/admin`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('readMetricsPort', () => {
  it('uses the fallback when unset', () => {
    expect(readMetricsPort(undefined, 4001)).toBe(4001);
    expect(readMetricsPort('  ', 4001)).toBe(4001);
  });

  it('accepts a valid port and rejects nonsense at boot', () => {
    expect(readMetricsPort('4100', 4001)).toBe(4100);
    expect(() => readMetricsPort('0', 4001)).toThrow(/METRICS_PORT/);
    expect(() => readMetricsPort('70000', 4001)).toThrow(/METRICS_PORT/);
    expect(() => readMetricsPort('abc', 4001)).toThrow(/METRICS_PORT/);
  });
});
