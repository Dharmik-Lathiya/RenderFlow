import type { LoggerService } from '@nestjs/common';

import type { Logger } from '@renderflow/observability';

/**
 * Routes Nest's internal framework logging into the shared pino logger, so all
 * process output is one structured stream with the same redaction rules
 * (AGENTS.md section 7).
 */
export function createNestLoggerAdapter(logger: Logger): LoggerService {
  return {
    log: (message: unknown, context?: string) => logger.info({ nest: context }, String(message)),
    warn: (message: unknown, context?: string) => logger.warn({ nest: context }, String(message)),
    debug: (message: unknown, context?: string) => logger.debug({ nest: context }, String(message)),
    verbose: (message: unknown, context?: string) =>
      logger.debug({ nest: context, verbose: true }, String(message)),
    error: (message: unknown, stack?: string, context?: string) =>
      logger.error({ nest: context, stack }, String(message)),
    fatal: (message: unknown, context?: string) =>
      logger.error({ nest: context, fatal: true }, String(message)),
  };
}
