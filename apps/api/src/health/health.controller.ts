import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/auth.guard';
// HealthService must stay a VALUE import: Nest's `emitDecoratorMetadata` reads
// `design:paramtypes` at runtime, and a type-only import makes it emit `Object`,
// which silently breaks dependency injection.
import { HealthService, type ReadinessReport } from './health.service';

/**
 * Health routes live outside the `/api/v1` prefix so orchestrator probes and
 * load balancers need no knowledge of the API version.
 */
@ApiTags('health')
@Controller()
@Public()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health/live')
  @ApiOperation({ summary: 'Liveness: the process is up' })
  @ApiResponse({ status: HttpStatus.OK, description: 'The process is accepting HTTP requests.' })
  live(): { status: 'ok'; service: string; uptimeSeconds: number } {
    return { status: 'ok', service: 'api', uptimeSeconds: this.health.uptimeSeconds };
  }

  @Get('health/ready')
  @ApiOperation({
    summary: 'Readiness: dependencies are reachable',
    description:
      'Returns 200 when PostgreSQL, Redis and S3 respond within their budgets, otherwise 503 with the same report body.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Every dependency is up.' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'At least one dependency is down; the body still carries the per-dependency report.',
  })
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.health.checkReadiness();
    response.status(report.status === 'degraded' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return report;
  }
}
