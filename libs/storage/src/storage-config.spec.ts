import { StorageConfigError, loadStorageConfig } from './storage-config';

const CREDENTIALS: NodeJS.ProcessEnv = {
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
};

describe('loadStorageConfig', () => {
  it('applies local MinIO defaults', () => {
    const config = loadStorageConfig(CREDENTIALS);
    expect(config).toEqual({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'renderflow-assets',
      accessKeyId: 'minio',
      secretAccessKey: 'minio12345',
      forcePathStyle: true,
    });
  });

  it('reads every value from the environment', () => {
    const config = loadStorageConfig({
      ...CREDENTIALS,
      S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      S3_REGION: 'eu-west-1',
      S3_BUCKET: 'renderflow-prod-assets',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(config.endpoint).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(config.region).toBe('eu-west-1');
    expect(config.bucket).toBe('renderflow-prod-assets');
    expect(config.forcePathStyle).toBe(false);
  });

  it('keeps path style on unless explicitly disabled', () => {
    expect(loadStorageConfig({ ...CREDENTIALS, S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle).toBe(
      true,
    );
    expect(loadStorageConfig({ ...CREDENTIALS, S3_FORCE_PATH_STYLE: '' }).forcePathStyle).toBe(
      true,
    );
  });

  it('requires credentials', () => {
    expect(() => loadStorageConfig({})).toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY are required/);
    expect(() => loadStorageConfig({ S3_ACCESS_KEY: 'minio' })).toThrow(StorageConfigError);
  });

  it('rejects an invalid endpoint', () => {
    expect(() => loadStorageConfig({ ...CREDENTIALS, S3_ENDPOINT: 'http://' })).toThrow(
      /not a valid URL/,
    );
    // `minio:9000` parses as URL scheme "minio:", so it fails the scheme check.
    expect(() => loadStorageConfig({ ...CREDENTIALS, S3_ENDPOINT: 'minio:9000' })).toThrow(
      /must be http\(s\)/,
    );
    expect(() => loadStorageConfig({ ...CREDENTIALS, S3_ENDPOINT: 'ftp://minio' })).toThrow(
      /must be http\(s\)/,
    );
  });

  it('rejects an invalid bucket name', () => {
    expect(() => loadStorageConfig({ ...CREDENTIALS, S3_BUCKET: 'RenderFlow_Assets' })).toThrow(
      /valid bucket name/,
    );
    expect(() => loadStorageConfig({ ...CREDENTIALS, S3_BUCKET: 'ab' })).toThrow(
      StorageConfigError,
    );
  });
});
