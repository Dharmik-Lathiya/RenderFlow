import { Injectable } from '@nestjs/common';

export type DependencyName = string;
export type DependencyState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Record<DependencyName, DependencyState>;
}

export type DependencyProbe = () => Promise<boolean>;

/**
 * Readiness probing (PROJECT.md section 14: "Health endpoints: /health/live,
 * /health/ready (DB, Redis, S3)").
 *
 * Probes are registered, not hard-coded, because the set of real dependencies
 * grows with the phases that introduce them (db in Phase 1, redis and storage in
 * Phase 4). A probe never throws: a rejected probe is a failed dependency, not a
 * crashed health endpoint.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = new Date();
  private readonly probes = new Map<DependencyName, DependencyProbe>();

  registerProbe(name: DependencyName, probe: DependencyProbe): void {
    this.probes.set(name, probe);
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
  }

  async checkReadiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.probes.entries()].map(
        async ([name, probe]): Promise<[DependencyName, DependencyState]> => {
          try {
            return [name, (await probe()) ? 'up' : 'down'];
          } catch {
            return [name, 'down'];
          }
        },
      ),
    );

    const checks = Object.fromEntries(entries);
    const degraded = Object.values(checks).some((state) => state === 'down');
    return { status: degraded ? 'degraded' : 'ok', checks };
  }
}
