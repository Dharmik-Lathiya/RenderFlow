import { HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
      'getObjectPrefix',
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

describe('S3Storage readiness check', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asks for the bucket itself first', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send') as jest.Mock;
    send.mockResolvedValue({});
    const storage = new S3Storage(OPTIONS);

    await expect(storage.checkHealth()).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('falls back to an object HEAD when ListBucket is not granted', async () => {
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const missing = Object.assign(new Error('Not Found'), {
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest.spyOn(S3Client.prototype, 'send') as jest.Mock;
    send.mockRejectedValueOnce(denied).mockRejectedValueOnce(missing);
    const storage = new S3Storage(OPTIONS);

    await expect(storage.checkHealth()).resolves.toBeUndefined();

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('reports a missing bucket as down instead of treating its 404 as healthy', async () => {
    const missing = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest.spyOn(S3Client.prototype, 'send') as jest.Mock;
    send.mockRejectedValueOnce(missing);
    const storage = new S3Storage(OPTIONS);

    await expect(storage.checkHealth()).rejects.toBeInstanceOf(StorageError);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
