import { Injectable } from '@nestjs/common';

export type DependencyName = string;
export type DependencyState = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Record<DependencyName, DependencyState>;
}

export type DependencyProbe = () => Promise<boolean>;

interface RegisteredProbe {
  probe: DependencyProbe;
  timeoutMs: number;
}

/**
 * A probe with no explicit budget still gets one. The number is deliberately
 * generous: it is a safety net for a forgotten registration, not the value the
 * production probes use (those are set in `health.probes.ts`).
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Readiness probing (PROJECT.md section 14: "Health endpoints: /health/live,
 * /health/ready (DB, Redis, S3)").
 *
 * Probes are registered, not hard-coded, because the set of real dependencies
 * grows with the phases that introduce them (db in Phase 1, redis and storage in
 * Phase 4). A probe never throws: a rejected probe is a failed dependency, not a
 * crashed health endpoint. Every probe also has a deadline, because a dependency
 * that accepts a TCP connection and then stops answering would otherwise hang
 * the endpoint - exactly the failure readiness exists to report.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = new Date();
  private readonly probes = new Map<DependencyName, RegisteredProbe>();

  registerProbe(
    name: DependencyName,
    probe: DependencyProbe,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  ): void {
    this.probes.set(name, { probe, timeoutMs });
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
  }

  async checkReadiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.probes.entries()].map(
        async ([name, { probe, timeoutMs }]): Promise<[DependencyName, DependencyState]> => {
          try {
            return [name, (await probeWithin(probe, timeoutMs)) ? 'up' : 'down'];
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

/**
 * Runs a probe and resolves `false` when it exceeds its budget.
 *
 * The losing promise is not cancelled - a query already sent to Postgres cannot
 * be unsent - but the endpoint no longer waits for it. Promise.race keeps a
 * handler attached to the probe, so a late rejection does not become an
 * unhandled rejection.
 */
async function probeWithin(probe: DependencyProbe, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      // Never keep a process alive just to time out a health probe.
      timer.unref();
    });

    return (await Promise.race([probe(), deadline])) === true;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
