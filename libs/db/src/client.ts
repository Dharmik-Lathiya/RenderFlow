import { PrismaClient } from '@prisma/client';

import { loadDbConfig, type DbConfig } from './db-config';

/**
 * PrismaClient lifecycle.
 *
 * One client per process. `getPrismaClient` is idempotent so a NestJS provider
 * and a worker bootstrap that both ask for the client share the same connection
 * pool; creating a second PrismaClient is a common cause of pool exhaustion.
 */

let instance: PrismaClient | null = null;

export function createPrismaClient(config: DbConfig): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: config.url } },
    log: config.logLevels.map((level) => ({ emit: 'event', level })),
  });
}

export function getPrismaClient(config?: DbConfig): PrismaClient {
  if (instance === null) {
    instance = createPrismaClient(config ?? loadDbConfig());
  }
  return instance;
}

/** Registered as a drain so SIGTERM closes the pool before the process exits. */
export async function disconnectPrisma(): Promise<void> {
  if (instance !== null) {
    await instance.$disconnect();
    instance = null;
  }
}

/** Test seam: forget the singleton without disconnecting. */
export function resetPrismaClientForTests(): void {
  instance = null;
}
