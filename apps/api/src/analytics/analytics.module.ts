import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics reads live in their own module because they depend on a table
 * (`post_metrics`) that this API never writes: the analytics worker owns the
 * write path, and keeping the read path separate makes clear that an endpoint
 * cannot accidentally become a second writer.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
