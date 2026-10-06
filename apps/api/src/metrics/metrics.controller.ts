// METRICS must stay a VALUE import: Nest's `emitDecoratorMetadata` reads
// `design:paramtypes` at runtime, and a type-only import makes it emit `Object`,
// which silently breaks dependency injection (see eslint.config.mjs).
import { Inject, Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { RenderFlowMetrics } from '@renderflow/observability';

import { METRICS } from './metrics.tokens';

/**
 * Prometheus scrape endpoint (PROJECT.md section 14).
 *
 * Un-versioned and un-cached so Prometheus always sees live values.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: RenderFlowMetrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }
}
