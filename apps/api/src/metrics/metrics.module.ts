import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createMetrics } from '@renderflow/observability';

import { MetricsController } from './metrics.controller';
import { METRICS } from './metrics.tokens';
import type { Env } from '../config/env';

/**
 * Owns the single `RenderFlowMetrics` instance for the process. `MetricsController`
 * and any future domain module that records counters inject the same token, so
 * /metrics aggregates everything.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createMetrics({
          enabled: config.get('METRICS_ENABLED', { infer: true }),
          labels: {
            env: config.get('NODE_ENV', { infer: true }),
            service: 'api',
          },
        }),
    },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
