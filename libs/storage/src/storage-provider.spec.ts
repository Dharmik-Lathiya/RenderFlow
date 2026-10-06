import { ObjectNotFoundError, StorageError } from './storage-provider';
import type { StorageProvider } from './storage-provider';

describe('StorageError', () => {
  it('is an Error subclass so `instanceof Error` filters catch it', () => {
    const error = new StorageError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StorageError');
    expect(error.message).toBe('boom');
  });

  it('keeps the underlying cause for diagnosis', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new StorageError('put failed', { cause });
    expect(error.cause).toBe(cause);
  });

  it('works without a cause', () => {
    expect(new StorageError('boom').cause).toBeUndefined();
  });
});

describe('ObjectNotFoundError', () => {
  it('names the missing key', () => {
    const error = new ObjectNotFoundError('renderflow/workspaces/w1/asset.png');
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toBeInstanceOf(Error);
    expect(error.key).toBe('renderflow/workspaces/w1/asset.png');
    expect(error.message).toContain('renderflow/workspaces/w1/asset.png');
  });

  it('keeps the specific name so callers can distinguish it from a real failure', () => {
    // A missing object is expected (checking existence before retrying a job);
    // a transport error is not. They must not collapse into one type.
    expect(new ObjectNotFoundError('k')).toBeInstanceOf(StorageError);
    expect(new ObjectNotFoundError('k').name).toBe('ObjectNotFoundError');
  });
});

describe('StorageProvider interface', () => {
  it('can be implemented by a test double', () => {
    // The point of the interface: a fake provider needs no S3, no credentials and
    // no network, which is what lets unit and e2e suites stay offline.
    const calls: string[] = [];

    const fake: StorageProvider = {
      putObject: async (input) => {
        calls.push(`put:${input.key}`);
        return {
          key: input.key,
          contentType: input.contentType,
          sizeBytes: input.body.byteLength,
          metadata: input.metadata ?? {},
        };
      },
      getObject: async (key) => {
        calls.push(`get:${key}`);
        return new Uint8Array([1, 2, 3]);
      },
      headObject: async (key) => {
        calls.push(`head:${key}`);
        return null;
      },
      deleteObject: async (key) => {
        calls.push(`del:${key}`);
      },
      createPresignedUpload: async (key, contentType, expiresInSeconds = 900) => ({
        url: `https://example.test/${key}`,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresInSeconds,
      }),
      createPresignedDownload: async (key) => `https://example.test/${key}`,
      checkHealth: async () => undefined,
    };

    expect(fake.createPresignedUpload).toBeDefined();
    expect(fake).toBeDefined();
  });
});
