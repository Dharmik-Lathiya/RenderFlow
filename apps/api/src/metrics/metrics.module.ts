import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createMetrics } from '@renderflow/observability';

import { MetricsCollectorService, MetricsController, metricsConfigFrom } from './metrics.service';
import { METRICS, METRICS_CONFIG, type MetricsConfig } from './metrics.tokens';
import type { Env } from '../config/env';

/**
 * Owns the single `RenderFlowMetrics` instance for the process, plus the
 * collector that makes its gauges mean something.
 *
 * Two independent switches, because they answer different questions:
 *
 *  - `METRICS_ENABLED` turns prom-client's default PROCESS metrics on and off.
 *    It costs roughly twenty collectors per registry, which is why a test suite
 *    turns it off.
 *  - `METRICS_COLLECTOR_ENABLED` controls the DERIVATION of the business gauges.
 *    Turning the first off must not turn the second off, or /metrics serves a
 *    well-formed document that says nothing.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsCollectorService,
    {
      provide: METRICS_CONFIG,
      inject: [ConfigService],
      useFactory: metricsConfigFrom,
    },
    {
      provide: METRICS,
      // Injects METRICS_CONFIG rather than reading ConfigService directly, so
      // the two switches have ONE source. Reading the environment here meant the
      // integration harness could override METRICS_CONFIG and still get an
      // instance built from the ambient values - the override would control the
      // collector but not the registry it writes to.
      inject: [METRICS_CONFIG, ConfigService],
      useFactory: (metricsConfig: MetricsConfig, config: ConfigService<Env, true>) =>
        createMetrics({
          enabled: metricsConfig.processEnabled,
          labels: {
            env: config.get('NODE_ENV', { infer: true }),
            service: 'api',
          },
        }),
    },
  ],
  exports: [METRICS, METRICS_CONFIG, MetricsCollectorService],
})
export class MetricsModule {}
