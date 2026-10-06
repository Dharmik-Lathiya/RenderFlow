import type { JobStage } from '@renderflow/common';

/**
 * Deterministic S3/MinIO object keys.
 *
 * Every object is namespaced by workspace first, so a lifecycle rule or an
 * `access_logs` query can never leak across tenants, and so a whole workspace's
 * assets can be deleted with a single prefix rule.
 *
 * Filenames are user-influenced (uploads, generated titles), so they are
 * sanitised rather than trusted: a key like `../../other-tenant/secret.png`
 * must never be reachable from a user-supplied name.
 */

export const STORAGE_NAMESPACE = 'renderflow';

const MAX_FILENAME_LENGTH = 120;
const FALLBACK_FILENAME = 'file';

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

function requireSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StorageKeyError(`${label} is required to build a storage key`);
  }
  // These are UUIDs or fixed enums in practice; reject separators defensively so
  // a key can never be re-interpreted as a different path.
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new StorageKeyError(`${label} must not contain path separators`);
  }
  return value;
}

/**
 * Reduces an arbitrary name to a safe single path segment.
 *
 * Strips directories, removes anything outside `[A-Za-z0-9._-]`, refuses `.`/`..`,
 * and never returns an empty string.
 */
export function sanitizeFilename(name: string): string {
  if (typeof name !== 'string') {
    return FALLBACK_FILENAME;
  }

  // Drop any directory component, including Windows separators.
  const base = name.split(/[/\\]/).pop() ?? '';
  let cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '');

  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = FALLBACK_FILENAME;
  }

  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const dot = cleaned.lastIndexOf('.');
    const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
    const stem = cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length);
    cleaned = `${stem}${ext}`;
  }

  return cleaned;
}

export interface AssetKeyInput {
  workspaceId: string;
  postId: string;
  assetId: string;
  filename: string;
}

export function buildAssetKey(input: AssetKeyInput): string {
  const workspaceId = requireSegment(input.workspaceId, 'workspaceId');
  const postId = requireSegment(input.postId, 'postId');
  const assetId = requireSegment(input.assetId, 'assetId');
  const filename = sanitizeFilename(input.filename);
  return `${STORAGE_NAMESPACE}/workspaces/${workspaceId}/posts/${postId}/assets/${assetId}/${filename}`;
}

/** Stage checkpoint written by a worker and replayed by the next attempt. */
export function buildCheckpointKey(jobId: string, stage: JobStage): string {
  return `${STORAGE_NAMESPACE}/jobs/${requireSegment(jobId, 'jobId')}/checkpoints/${stage}.json`;
}

/** Scratch space for a stage's intermediate artefacts (frames, audio chunks). */
export function buildStagingKey(jobId: string, name: string): string {
  return `${STORAGE_NAMESPACE}/jobs/${requireSegment(jobId, 'jobId')}/staging/${sanitizeFilename(name)}`;
}

/** Objects older than this are expired by a bucket lifecycle rule. */
export const PRESIGNED_URL_TTL_SECONDS = 900;

export interface ParsedAssetKey {
  workspaceId: string;
  postId: string;
  assetId: string;
  filename: string;
}

export function parseAssetKey(key: string): ParsedAssetKey {
  const parts = key.split('/');
  // renderflow/workspaces/{ws}/posts/{post}/assets/{asset}/{filename}
  if (
    parts.length !== 8 ||
    parts[0] !== STORAGE_NAMESPACE ||
    parts[1] !== 'workspaces' ||
    parts[3] !== 'posts' ||
    parts[5] !== 'assets'
  ) {
    throw new StorageKeyError(`Unrecognised asset key: "${key}"`);
  }

  const [, , workspaceId, , postId, , assetId, filename] = parts;
  if (!workspaceId || !postId || !assetId || !filename) {
    throw new StorageKeyError(`Incomplete asset key: "${key}"`);
  }

  return { workspaceId, postId, assetId, filename };
}
