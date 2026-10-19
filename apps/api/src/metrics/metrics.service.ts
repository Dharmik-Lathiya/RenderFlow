// METRICS must stay a VALUE import: Nest's `emitDecoratorMetadata` reads
// `design:paramtypes` at runtime, and a type-only import makes it emit `Object`,
// which silently breaks dependency injection (see eslint.config.mjs).
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Res,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { getDb } from '@renderflow/db';
import { MetricsCollector, type RenderFlowMetrics } from '@renderflow/observability';

import { Public } from '../auth/auth.guard';
import { METRICS, METRICS_CONFIG, type MetricsConfig } from './metrics.tokens';
import type { Env } from '../config/env';

/**
 * Populates the Prometheus gauges.
 *
 * Without this, `/metrics` answers with a correct document full of zeros: the
 * metrics were defined in Phase 0 and nothing ever set them. A dashboard built on
 * that looks healthy while the system is on fire, which is worse than having no
 * dashboard - it spends someone's trust.
 *
 * The API runs the collector rather than each worker, because most of these
 * facts are properties of a ROW rather than of a process, and one process with a
 * database pool can answer for all of them.
 */
@ApiTags('metrics')
@Injectable()
export class MetricsCollectorService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private collector: MetricsCollector | null = null;

  constructor(
    @Inject(METRICS) private readonly metrics: RenderFlowMetrics,
    @Inject(METRICS_CONFIG) private readonly config: MetricsConfig,
  ) {}

  /**
   * `getDb` is injected as a FUNCTION, not called once here.
   *
   * Capturing `getDb()` at construction pins whatever pool happened to be current,
   * and the test harness (and anything else that resets the singleton) replaces
   * it. The result is one leaked pool per application instance, which starves the
   * connection limit and makes unrelated suites fail in a way that looks nothing
   * like the cause. Resolving per refresh means the collector always uses the
   * current pool and holds a reference to none of them.
   */
  onModuleInit(): void {
    if (!this.config.collectorEnabled) {
      return;
    }

    this.collector = new MetricsCollector({
      getDb: () => getDb(),
      metrics: this.metrics,
      intervalMs: this.config.intervalMs,
    });

    this.collector.start();
  }

  /**
   * `onModuleDestroy`, not only `onApplicationShutdown`.
   *
   * Nest runs `onApplicationShutdown` only when `enableShutdownHooks()` was
   * called, which happens for a real process listening on signals and does NOT
   * happen for a testing application. With the hook on the wrong lifecycle, every
   * test app kept a live timer polling the database after it was closed.
   */
  onModuleDestroy(): void {
    this.stop();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  private stop(): void {
    this.collector?.stop();
    this.collector = null;
  }
}

/** Reads the config a `MetricsCollectorService` needs, for the DI factory. */
export function metricsConfigFrom(config: ConfigService<Env, true>): MetricsConfig {
  return {
    // No `infer: true` on these: with inference on, a key missing from the
    // environment THROWS rather than returning undefined, and the throw lands in
    // `onModuleInit`, after Nest has finished wiring - so /metrics would serve a
    // document whose gauges nothing has ever set.
    processEnabled: config.get<boolean>('METRICS_ENABLED') ?? true,
    collectorEnabled: config.get<boolean>('METRICS_COLLECTOR_ENABLED') ?? true,
    intervalMs: config.get<number>('METRICS_INTERVAL_MS') ?? 15_000,
  };
}

@ApiTags('metrics')
@Controller('metrics')
@Public()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: RenderFlowMetrics) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus metrics' })
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }
}
