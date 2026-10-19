/**
 * Nest DI tokens that live in the app rather than in a lib, so `@renderflow/*`
 * never has to depend on Nest (AGENTS.md section 3 dependency rules).
 */
export const METRICS = Symbol('RENDERFLOW_METRICS');

/**
 * Metrics settings, as a plain object rather than read from `ConfigService` at
 * the point of use.
 *
 * A dedicated token because the integration harness can override a TOKEN but
 * cannot change the environment a module already validated at import time. That
 * is why `TestAppOptions.env` reaches `RATE_LIMIT_CONFIG` and not `ConfigService`
 * - and the same seam is what lets a suite run with the collector off and the
 * `/metrics` specs run with it on, in the same file.
 */
export const METRICS_CONFIG = Symbol('RENDERFLOW_METRICS_CONFIG');

export interface MetricsConfig {
  /** prom-client's default PROCESS metrics. Costs ~20 collectors per registry. */
  processEnabled: boolean;
  /** Whether the business gauges are derived from the database. */
  collectorEnabled: boolean;
  /** How often the derivation runs, in ms. */
  intervalMs: number;
}
