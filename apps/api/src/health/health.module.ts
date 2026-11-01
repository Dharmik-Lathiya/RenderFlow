import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthProbesService } from './health.probes';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, HealthProbesService],
  exports: [HealthService],
})
export class HealthModule {}
