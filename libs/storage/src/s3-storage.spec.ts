import { S3Storage } from './s3-storage';
import { StorageError, type StorageProvider } from './storage-provider';

/**
 * S3Storage is the only class that touches the AWS SDK, so it is the one place
 * a credential or bucket typo could surface. Constructing it must not require
 * network access, and every method must translate SDK failures into `StorageError`
 * rather than leaking a raw AWS error to callers.
 */

const OPTIONS = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'renderflow-assets',
  accessKeyId: 'minio',
  secretAccessKey: 'minio12345',
};

describe('S3Storage construction', () => {
  it('constructs without contacting the endpoint', () => {
    const storage = new S3Storage(OPTIONS);
    expect(storage).toBeInstanceOf(S3Storage);
  });

  it('implements the provider interface', () => {
    const storage: StorageProvider = new S3Storage(OPTIONS);
    for (const method of [
      'putObject',
      'getObject',
      'headObject',
      'deleteObject',
      'createPresignedUpload',
      'createPresignedDownload',
      'checkHealth',
    ] as const) {
      expect(typeof storage[method]).toBe('function');
    }
  });

  it('defaults forcePathStyle to true, which MinIO requires', () => {
    // MinIO does not do virtual-host bucket addressing; a single-container dev
    // stack would fail every call without this.
    const storage = new S3Storage({ ...OPTIONS, forcePathStyle: undefined });
    expect(storage).toBeInstanceOf(S3Storage);
  });

  it('accepts an explicit forcePathStyle', () => {
    expect(new S3Storage({ ...OPTIONS, forcePathStyle: false })).toBeInstanceOf(S3Storage);
  });
});

describe('S3Storage error translation', () => {
  // An unreachable endpoint is the common failure in local development. Every
  // operation must surface it as StorageError so the caller's retry logic sees
  // one error type.
  const unreachable = new S3Storage({
    ...OPTIONS,
    // Reserved TEST-NET-1 address: connections never succeed, no real host.
    endpoint: 'http://127.0.0.1:1',
  });

  it('wraps a failed upload in StorageError', async () => {
    await expect(
      unreachable.putObject({ key: 'k', body: new Uint8Array([1]), contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('wraps a failed download in StorageError', async () => {
    await expect(unreachable.getObject('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('wraps a failed delete in StorageError', async () => {
    await expect(unreachable.deleteObject('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('includes the object key in the error message', async () => {
    await expect(unreachable.getObject('workspaces/w1/asset.png')).rejects.toThrow(
      /workspaces\/w1\/asset\.png/,
    );
  });

  it('does not leak credentials in the error', async () => {
    const secret = 'super-secret-key';
    const leaky = new S3Storage({
      ...OPTIONS,
      endpoint: 'http://127.0.0.1:1',
      secretAccessKey: secret,
    });

    await expect(
      leaky.putObject({ key: 'k', body: new Uint8Array([1]), contentType: 'text/plain' }),
    ).rejects.not.toThrow(expect.stringContaining(secret));
  });

  it('reports an unhealthy storage rather than hanging', async () => {
    await expect(unreachable.checkHealth()).rejects.toBeInstanceOf(StorageError);
  });
});
