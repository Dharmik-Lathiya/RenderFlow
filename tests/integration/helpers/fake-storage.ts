import type { StorageLike } from '../../../apps/api/src/workspaces/assets.service';

/**
 * An in-memory stand-in for object storage.
 *
 * Both the asset and studio suites need one: MinIO is not running in CI, and the
 * behaviour under test - access checks, MIME and size validation, confirming
 * against the *real* object rather than the declared size - is all server-side.
 *
 * `objects` holds what a client "uploaded", so a test can lie about the declared
 * size and have the fake accept the real one, which is exactly the case
 * `confirmUpload` exists to catch.
 */
export interface FakeStorage extends StorageLike {
  objects: Map<string, { sizeBytes: number; contentType: string }>;
  /** Raw bytes the server wrote, so a test can assert on what was produced. */
  bodies: Map<string, Uint8Array>;
  putObject(input: { key: string; body: Uint8Array; contentType: string }): Promise<unknown>;
  /** Makes the next `deleteObject` throw, to exercise the failure path. */
  setDeleteFailure(value: boolean): void;
}

export function fakeStorage(): FakeStorage {
  const objects = new Map<string, { sizeBytes: number; contentType: string }>();
  const bodies = new Map<string, Uint8Array>();
  let deleteFails = false;

  return {
    objects,

    /** Bodies written by the server, so a test can assert on what was produced. */
    bodies,

    setDeleteFailure(value: boolean): void {
      deleteFails = value;
    },

    putObject: async ({ key, body, contentType }) => {
      objects.set(key, { sizeBytes: body.byteLength, contentType });
      bodies.set(key, body);
      return { key, contentType, sizeBytes: body.byteLength, metadata: {} };
    },

    createPresignedUpload: async (key, contentType, expiresInSeconds = 900) => {
      objects.set(key, { sizeBytes: 0, contentType });
      return {
        url: `https://storage.test/${key}?signature=fake`,
        method: 'PUT' as const,
        headers: { 'content-type': contentType },
        expiresInSeconds,
      };
    },

    createPresignedDownload: async (key) => `https://storage.test/${key}?download=1`,

    headObject: async (key) => objects.get(key) ?? null,

    deleteObject: async (key) => {
      if (deleteFails) {
        throw new Error('storage unavailable');
      }
      objects.delete(key);
    },
  };
}
