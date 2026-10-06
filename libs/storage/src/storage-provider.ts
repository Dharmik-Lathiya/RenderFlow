/**
 * Storage abstraction.
 *
 * AGENTS.md rule: all storage integrations sit behind an interface with a mock
 * implementation, and CI never touches a real S3. `S3Storage` is the only class
 * that knows about the AWS SDK.
 */

export interface PutObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  /** Extra object metadata surfaced on read. */
  metadata?: Record<string, string>;
}

export interface ObjectMetadata {
  key: string;
  contentType: string;
  sizeBytes: number;
  etag?: string;
  lastModified?: Date;
  metadata: Record<string, string>;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<ObjectMetadata>;
  getObject(key: string): Promise<Uint8Array>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;
  createPresignedUpload(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<PresignedUpload>;
  createPresignedDownload(key: string, expiresInSeconds?: number): Promise<string>;
  /** Used by /health/ready. */
  checkHealth(): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}
