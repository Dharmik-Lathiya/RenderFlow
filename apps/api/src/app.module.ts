import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { envSchema } from './config/env';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';

/**
 * Phase 0 root module: health + metrics only.
 *
 * Domain modules (auth, users, brands, campaigns, posts, credits, jobs, assets,
 * schedule, social-accounts, analytics, notifications, admin, outbox) are added
 * by the phase that needs them, per PROJECT.md section 12.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Fail at boot on a bad config rather than at first request.
      validate: (config: Record<string, unknown>) => envSchema.parse(config),
    }),
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
