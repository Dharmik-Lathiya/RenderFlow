/**
 * Storage configuration. Read once at the process edge, then passed down.
 *
 * AGENTS.md rule: "Never read `process.env` directly outside the config module."
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

/** S3 bucket naming rules, minus the IP-address restriction we cannot check here. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const DEFAULTS = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'renderflow-assets',
  forcePathStyle: true,
};

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const endpoint = env.S3_ENDPOINT?.trim() || DEFAULTS.endpoint;
  const region = env.S3_REGION?.trim() || DEFAULTS.region;
  const bucket = env.S3_BUCKET?.trim() || DEFAULTS.bucket;
  const accessKeyId = env.S3_ACCESS_KEY?.trim() ?? '';
  const secretAccessKey = env.S3_SECRET_KEY?.trim() ?? '';

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new StorageConfigError(`S3_ENDPOINT is not a valid URL: "${endpoint}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageConfigError(`S3_ENDPOINT must be http(s), received "${endpoint}"`);
  }

  if (!BUCKET_PATTERN.test(bucket)) {
    throw new StorageConfigError(
      `S3_BUCKET must be a valid bucket name (lowercase, 3-63 chars), received "${bucket}"`,
    );
  }

  if (accessKeyId === '' || secretAccessKey === '') {
    throw new StorageConfigError('S3_ACCESS_KEY and S3_SECRET_KEY are required');
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    // MinIO needs path-style; real AWS does not.
    forcePathStyle: env.S3_FORCE_PATH_STYLE
      ? env.S3_FORCE_PATH_STYLE !== 'false'
      : DEFAULTS.forcePathStyle,
  };
}
