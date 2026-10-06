import 'reflect-metadata';

import { createGracefulShutdown } from '@renderflow/common';
import { createLogger, toShutdownLogger } from '@renderflow/observability';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { assertCorsIsExplicit, corsOrigins, loadEnv } from './config/env';
import { createNestLoggerAdapter } from './logger/nest-logger';

/** Routes served at the root, not under /api/v1 (orchestrator + Prometheus). */
const UNVERSIONED_ROUTES = [
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
  { path: 'metrics', method: RequestMethod.GET },
];

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  assertCorsIsExplicit(env);

  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });
  const shutdown = createGracefulShutdown({ name: 'api', logger: toShutdownLogger(logger) });
  shutdown.install();

  const app = await NestFactory.create(AppModule, {
    logger: createNestLoggerAdapter(logger),
  });

  app.setGlobalPrefix('api/v1', { exclude: UNVERSIONED_ROUTES });
  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
  });

  await app.listen(env.API_PORT);

  // Registered after listen() so the drain cannot run before there is a server
  // to close. LIFO order means HTTP stops accepting before anything else drains.
  shutdown.registerDrain('http-server', async () => {
    await app.close();
  });

  logger.info(
    { app: 'api', port: env.API_PORT, env: env.NODE_ENV, pid: process.pid },
    'api listening',
  );
}

bootstrap().catch((error: unknown) => {
  // Nothing is listening yet, so there is no logger; use stderr directly.
  process.stderr.write(`[api] failed to start: ${String(error)}\n`);
  process.exit(1);
});
