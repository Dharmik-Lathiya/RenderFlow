import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { PRESIGNED_URL_TTL_SECONDS } from './storage-key';
import {
  ObjectNotFoundError,
  StorageError,
  type ObjectMetadata,
  type PresignedUpload,
  type PutObjectInput,
  type StorageProvider,
} from './storage-provider';

/**
 * S3 / MinIO implementation.
 *
 * `forcePathStyle` is required for MinIO: virtual-host bucket addressing is not
 * available on a single-container dev stack.
 */
export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly options: S3StorageOptions) {
    const config: S3ClientConfig = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    };
    this.client = new S3Client(config);
    this.bucket = options.bucket;
  }

  async putObject(input: PutObjectInput): Promise<ObjectMetadata> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
      );
    } catch (error) {
      throw new StorageError(`Failed to put object ${input.key}`, { cause: error });
    }
    return {
      key: input.key,
      contentType: input.contentType,
      sizeBytes: input.body.byteLength,
      metadata: input.metadata ?? {},
    };
  }

  async getObject(key: string): Promise<Uint8Array> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) {
        throw new ObjectNotFoundError(key);
      }
      return bytes;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw error;
      }
      throw new StorageError(`Failed to get object ${key}`, { cause: error });
    }
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        contentType: result.ContentType ?? 'application/octet-stream',
        sizeBytes: result.ContentLength ?? 0,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata: result.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw new StorageError(`Failed to stat object ${key}`, { cause: error });
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new StorageError(`Failed to delete object ${key}`, { cause: error });
    }
  }

  async createPresignedUpload(
    key: string,
    contentType: string,
    expiresInSeconds: number = PRESIGNED_URL_TTL_SECONDS,
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresInSeconds };
  }

  async createPresignedDownload(
    key: string,
    expiresInSeconds = PRESIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async checkHealth(): Promise<void> {
    // A HeadBucket needs ListBucket permission; a HeadObject on a known-missing
    // key only needs s3:GetObject and is enough to prove reachability + auth.
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: 'renderflow/healthcheck' }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new StorageError('S3 health check failed', { cause: error });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ===
      'number' &&
    (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === 404
  );
}
