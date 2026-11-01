import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { getDb } from '@renderflow/db';
import { createRedisPingProbe, type RedisPingProbe } from '@renderflow/queue';
import { S3Storage, loadStorageConfig, type StorageProvider } from '@renderflow/storage';

import type { Env } from '../config/env';
import { HealthService, type DependencyProbe } from './health.service';

/**
 * Per-dependency budgets. They are short enough that an orchestrator gets an
 * answer before its own probe timeout, and long enough to survive a slow but
 * working dependency. S3 gets the extra second because an object-store HEAD is
 * a network round trip, not a local `SELECT 1`.
 */
export const DB_PROBE_TIMEOUT_MS = 2_000;
export const REDIS_PROBE_TIMEOUT_MS = 2_000;
export const S3_PROBE_TIMEOUT_MS = 3_000;

export interface DependencyProbes {
  db: DependencyProbe;
  redis: DependencyProbe;
  s3: DependencyProbe;
}

/**
 * Registers the readiness contract in one place.
 *
 * The names are part of the HTTP response (`checks.db`, `checks.redis`,
 * `checks.s3`), so they must not come from a class name or an environment key.
 */
export function registerDependencyProbes(health: HealthService, probes: DependencyProbes): void {
  health.registerProbe('db', probes.db, DB_PROBE_TIMEOUT_MS);
  health.registerProbe('redis', probes.redis, REDIS_PROBE_TIMEOUT_MS);
  health.registerProbe('s3', probes.s3, S3_PROBE_TIMEOUT_MS);
}

/**
 * Wires the real dependencies into `HealthService` once, at bootstrap.
 *
 * Nothing here dials a dependency during `onModuleInit`: the Redis client is
 * lazy, `getDb` opens its pool on the first query, and S3 construction is
 * offline. That matters because the integration suite and the OpenAPI dump boot
 * the full application without Redis or MinIO - and because `/health/live` must
 * stay answerable when a dependency is down.
 */
@Injectable()
export class HealthProbesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthProbesService.name);
  private redis: RedisPingProbe | null = null;
  private storage: StorageProvider | null = null;

  constructor(
    private readonly health: HealthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.redis = createRedisPingProbe({
      redisUrl: this.config.get('REDIS_URL', { infer: true }),
      connectTimeoutMs: REDIS_PROBE_TIMEOUT_MS,
    });
    this.storage = this.buildStorage();

    registerDependencyProbes(this.health, {
      db: async () => {
        await getDb().execute('SELECT 1');
        return true;
      },
      redis: async () => {
        if (this.redis === null) {
          return false;
        }
        return this.redis.ping();
      },
      s3: async () => {
        if (this.storage === null) {
          return false;
        }
        await this.storage.checkHealth();
        return true;
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    this.storage = null;

    if (redis !== null) {
      await redis.close();
    }
  }

  /**
   * Storage is optional at boot for the same reason it is in `AssetsService`:
   * a missing bucket configuration must degrade readiness, not prevent the API
   * from starting and answering `/health/live`.
   */
  private buildStorage(): StorageProvider | null {
    try {
      return new S3Storage(loadStorageConfig());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`object storage is not configured; readiness reports s3 down: ${message}`);
      return null;
    }
  }
}
