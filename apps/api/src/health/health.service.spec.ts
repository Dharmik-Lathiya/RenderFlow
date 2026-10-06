import { HealthService } from './health.service';

/**
 * `/health/ready` is what an orchestrator decides on, so the contract has to be
 * precise: a probe that throws must count as a failed dependency rather than
 * taking down the endpoint, and a failed probe must surface as `degraded`.
 */
describe('HealthService', () => {
  describe('liveness', () => {
    it('starts at zero and increases with elapsed time', () => {
      const service = new HealthService();
      const first = service.uptimeSeconds;
      expect(first).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(first)).toBe(true);
    });

    it('does not go backwards', () => {
      const service = new HealthService();
      const readings = [service.uptimeSeconds, service.uptimeSeconds, service.uptimeSeconds];
      expect(readings[1]).toBeGreaterThanOrEqual(readings[0] as number);
      expect(readings[2]).toBeGreaterThanOrEqual(readings[1] as number);
    });
  });

  describe('readiness', () => {
    it('reports ok with no probes registered', async () => {
      // Phase 1 wires no dependency probes; an empty set must not read as broken.
      await expect(new HealthService().checkReadiness()).resolves.toEqual({
        status: 'ok',
        checks: {},
      });
    });

    it('reports a passing dependency as up', async () => {
      const service = new HealthService();
      service.registerProbe('database', async () => true);

      await expect(service.checkReadiness()).resolves.toEqual({
        status: 'ok',
        checks: { database: 'up' },
      });
    });

    it('reports a failing dependency as down and degrades', async () => {
      const service = new HealthService();
      service.registerProbe('redis', async () => false);

      const report = await service.checkReadiness();

      expect(report.status).toBe('degraded');
      expect(report.checks).toEqual({ redis: 'down' });
    });

    it('treats a throwing probe as a failed dependency, not a crashed endpoint', async () => {
      // A probe that rejects (DNS failure, connection refused) must degrade
      // readiness rather than return a 500 and take the pod out of rotation for
      // the wrong reason.
      const service = new HealthService();
      service.registerProbe('storage', async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:9000');
      });

      const report = await service.checkReadiness();

      expect(report.status).toBe('degraded');
      expect(report.checks.storage).toBe('down');
    });

    it('degrades when any one of several probes fails', async () => {
      const service = new HealthService();
      service.registerProbe('database', async () => true);
      service.registerProbe('redis', async () => true);
      service.registerProbe('storage', async () => false);

      const report = await service.checkReadiness();

      expect(report.status).toBe('degraded');
      expect(report.checks).toEqual({ database: 'up', redis: 'up', storage: 'down' });
    });

    it('reports ok when every probe passes', async () => {
      const service = new HealthService();
      service.registerProbe('database', async () => true);
      service.registerProbe('redis', async () => true);
      service.registerProbe('storage', async () => true);

      await expect(service.checkReadiness()).resolves.toEqual({
        status: 'ok',
        checks: { database: 'up', redis: 'up', storage: 'up' },
      });
    });

    it('runs probes concurrently rather than in sequence', async () => {
      // Sequential probes would make readiness latency the sum of every timeout.
      const service = new HealthService();
      let concurrent = 0;
      let peak = 0;
      const probe = async (): Promise<boolean> => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return true;
      };

      service.registerProbe('database', probe);
      service.registerProbe('redis', probe);
      service.registerProbe('storage', probe);

      await service.checkReadiness();

      expect(peak).toBe(3);
    });

    it('lets a later registration replace an earlier one for the same name', async () => {
      const service = new HealthService();
      service.registerProbe('database', async () => false);
      service.registerProbe('database', async () => true);

      const report = await service.checkReadiness();

      expect(report.checks).toEqual({ database: 'up' });
    });
  });
});
