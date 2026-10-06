import {
  STORAGE_NAMESPACE,
  StorageKeyError,
  buildAssetKey,
  buildCheckpointKey,
  buildStagingKey,
  parseAssetKey,
  sanitizeFilename,
} from './storage-key';

const base = {
  workspaceId: 'ws-1',
  postId: 'post-1',
  assetId: 'asset-1',
  filename: 'poster.png',
};

describe('sanitizeFilename', () => {
  it('leaves a safe filename untouched', () => {
    expect(sanitizeFilename('poster.png')).toBe('poster.png');
  });

  it('strips directory traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/absolute/path/image.jpg')).toBe('image.jpg');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
  });

  it('replaces characters outside the safe set', () => {
    expect(sanitizeFilename('my post (1).png')).toBe('my_post_1_.png');
    expect(sanitizeFilename('emoji 🎉.png')).toBe('emoji_.png');
  });

  it('never returns a traversal token', () => {
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('.')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
  });

  it('handles non-string input defensively', () => {
    expect(sanitizeFilename(undefined as unknown as string)).toBe('file');
    expect(sanitizeFilename(42 as unknown as string)).toBe('file');
  });

  it('caps length while preserving the extension', () => {
    const long = `${'a'.repeat(300)}.png`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('.png')).toBe(true);
  });

  it('truncates a name with no extension to a sane length', () => {
    expect(sanitizeFilename('b'.repeat(300)).length).toBe(120);
  });
});

describe('buildAssetKey', () => {
  it('namespaces by workspace first', () => {
    expect(buildAssetKey(base)).toBe(
      `${STORAGE_NAMESPACE}/workspaces/ws-1/posts/post-1/assets/asset-1/poster.png`,
    );
  });

  it('sanitises the filename inside the key', () => {
    const key = buildAssetKey({ ...base, filename: '../../escape.png' });
    expect(key).toBe(`${STORAGE_NAMESPACE}/workspaces/ws-1/posts/post-1/assets/asset-1/escape.png`);
    expect(key).not.toContain('..');
  });

  it('refuses ids containing path separators', () => {
    expect(() => buildAssetKey({ ...base, workspaceId: '../other' })).toThrow(StorageKeyError);
    expect(() => buildAssetKey({ ...base, postId: 'a/b' })).toThrow(/path separators/);
    expect(() => buildAssetKey({ ...base, assetId: '' })).toThrow(/required/);
  });

  it('produces distinct keys per tenant', () => {
    const a = buildAssetKey({ ...base, workspaceId: 'ws-a' });
    const b = buildAssetKey({ ...base, workspaceId: 'ws-b' });
    expect(a).not.toBe(b);
  });
});

describe('buildCheckpointKey and buildStagingKey', () => {
  it('builds a deterministic checkpoint key per stage', () => {
    expect(buildCheckpointKey('job-1', 'IMAGE')).toBe(
      `${STORAGE_NAMESPACE}/jobs/job-1/checkpoints/IMAGE.json`,
    );
    expect(buildCheckpointKey('job-1', 'IMAGE')).toBe(buildCheckpointKey('job-1', 'IMAGE'));
  });

  it('sanitises staging file names', () => {
    expect(buildStagingKey('job-1', '../frame 01.png')).toBe(
      `${STORAGE_NAMESPACE}/jobs/job-1/staging/frame_01.png`,
    );
  });

  it('rejects a job id with a separator', () => {
    expect(() => buildCheckpointKey('jobs/../x', 'IMAGE')).toThrow(StorageKeyError);
  });
});

describe('parseAssetKey', () => {
  it('round-trips a key produced by buildAssetKey', () => {
    const key = buildAssetKey(base);
    expect(parseAssetKey(key)).toEqual({
      workspaceId: 'ws-1',
      postId: 'post-1',
      assetId: 'asset-1',
      filename: 'poster.png',
    });
  });

  it('rejects keys that are not asset keys', () => {
    expect(() => parseAssetKey('some/other/key')).toThrow(/Unrecognised/);
    expect(() => parseAssetKey(`${STORAGE_NAMESPACE}/jobs/job-1/checkpoints/IMAGE.json`)).toThrow(
      StorageKeyError,
    );
  });
});
