import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { createLogger } from '@renderflow/observability';
import { S3Storage, loadStorageConfig, type StorageProvider } from '@renderflow/storage';
import { getDb, type Database } from '@renderflow/db';

import type { RequestUploadInput, StudioService } from './studio.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { assets } from '@renderflow/db';
import { eq } from 'drizzle-orm';

/**
 * Asset upload and download.
 *
 * Bytes never pass through the API. The client asks for a presigned PUT, streams
 * straight to S3, then calls `confirm`; downloads are presigned GETs with a short
 * expiry. That keeps a 25 MB upload from occupying an API request for the
 * duration and means the API is not a bandwidth bottleneck.
 *
 * The cost is that the server cannot see the bytes until after the upload, so
 * validation is split: type and declared size are checked before the URL is
 * issued, and the real size is re-checked from `headObject` on confirm.
 */

export interface PresignedUploadResult {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface PresignedDownloadResult {
  url: string;
  expiresInSeconds: number;
}

/** Lets tests supply a double; production builds an S3 client from config. */
export interface StorageLike {
  createPresignedUpload(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<PresignedUploadResult>;
  createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string>;
  headObject(key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
  deleteObject?(key: string): Promise<void>;
}

let logger: ReturnType<typeof createLogger> | null = null;

/** Wires the logger at boot. Called once from `main.ts`. */
export function configureAssetsLogger(instance: ReturnType<typeof createLogger>): void {
  logger = instance;
}

function log(): ReturnType<typeof createLogger> {
  logger ??= createLogger({ service: 'assets' });
  return logger;
}

@Injectable()
export class AssetsService implements OnModuleInit {
  private db!: Database;
  private storage!: StorageLike;

  constructor(private readonly access: WorkspaceAccessService) {}

  onModuleInit(): void {
    this.db = getDb();
    this.storage = buildStorage();
  }

  /** Test seam: replace the storage client without a running MinIO. */
  setStorage(storage: StorageLike): void {
    this.storage = storage;
  }

  async requestUpload(
    userId: string,
    studio: StudioService,
    input: RequestUploadInput,
  ): Promise<{ asset: unknown; upload: PresignedUploadResult }> {
    return studio.requestUpload(userId, this.storage, input.workspaceId, input);
  }

  async confirm(userId: string, studio: StudioService, assetId: string): Promise<unknown> {
    return studio.confirmUpload(userId, assetId, this.storage);
  }

  async downloadUrl(
    userId: string,
    studio: StudioService,
    assetId: string,
  ): Promise<PresignedDownloadResult> {
    return studio.getDownloadUrl(userId, assetId, this.storage);
  }

  /** Deletes the row and, best-effort, the object. */
  async remove(userId: string, assetId: string): Promise<void> {
    const scoped = await this.access.scope({
      userId,
      resource: 'asset',
      lookup: async (db) => {
        const rows = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    await this.db.delete(assets).where(eq(assets.id, assetId));

    try {
      await this.storage.deleteObject?.(scoped.value.storageKey);
    } catch (error) {
      // The row is gone, which is what the caller asked for. A leftover object is
      // an operational nuisance, not a correctness problem, and failing the
      // request would tell the user their delete failed when it did not.
      log().warn({ assetId, err: error }, 'asset row deleted but object removal failed');
    }
  }
}

/**
 * Builds the storage client from config.
 *
 * Falls back to a rejecting double rather than throwing at boot: `/health/live`
 * must stay answerable when object storage is misconfigured, and a hard failure
 * here would take the whole API down over a dependency a given request may never
 * touch. `/health/ready` reports the real state.
 */
function buildStorage(): StorageLike {
  try {
    const storage: StorageProvider = new S3Storage(loadStorageConfig());
    return {
      createPresignedUpload: (key, contentType, expiresInSeconds) =>
        storage.createPresignedUpload(key, contentType, expiresInSeconds),
      createPresignedDownload: (key, expiresInSeconds) =>
        storage.createPresignedDownload(key, expiresInSeconds),
      headObject: async (key) => {
        const metadata = await storage.headObject(key);
        return metadata === null
          ? null
          : { sizeBytes: metadata.sizeBytes, contentType: metadata.contentType };
      },
      deleteObject: (key: string) => storage.deleteObject(key),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log().error({ err: error }, `storage unavailable: ${message}`);
    return {
      createPresignedUpload: () => reject(message),
      createPresignedDownload: () => reject(message),
      headObject: () => reject(message),
    };
  }
}

/** Always rejects, standing in for a storage client that could not be built. */
function reject(message: string): Promise<never> {
  return Promise.reject(
    new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, `Storage is unavailable: ${message}`),
  );
}
