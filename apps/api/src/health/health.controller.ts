import { Controller, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';

import { Public } from '../auth/auth.guard';
// HealthService must stay a VALUE import: Nest's `emitDecoratorMetadata` reads
// `design:paramtypes` at runtime, and a type-only import makes it emit `Object`,
// which silently breaks dependency injection.
import { HealthService, type ReadinessReport } from './health.service';

/**
 * Health routes live outside the `/api/v1` prefix so orchestrator probes and
 * load balancers need no knowledge of the API version.
 */
@Controller()
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health/live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok'; service: string; uptimeSeconds: number } {
    return { status: 'ok', service: 'api', uptimeSeconds: this.health.uptimeSeconds };
  }

  @Get('health/ready')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<ReadinessReport> {
    return this.health.checkReadiness();
  }
}
