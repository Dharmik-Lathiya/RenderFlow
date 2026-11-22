import {
  parseRedisUrl,
  resolveRedisUrl,
  toConnectionOptions,
  RedisUrlError,
} from './redis-connection';

describe('parseRedisUrl', () => {
  it('parses a plain redis url', () => {
    expect(parseRedisUrl('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 0,
      tls: false,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  });

  it('defaults the port to 6379 when omitted', () => {
    expect(parseRedisUrl('redis://cache').port).toBe(6379);
  });

  it('parses a database index', () => {
    expect(parseRedisUrl('redis://localhost:6379/3').db).toBe(3);
    expect(parseRedisUrl('redis://localhost:6379/0').db).toBe(0);
  });

  it('parses credentials', () => {
    const options = parseRedisUrl('redis://user:pa%40ss@localhost:6379');
    expect(options.username).toBe('user');
    expect(options.password).toBe('pa@ss');
  });

  it('enables TLS for rediss', () => {
    expect(parseRedisUrl('rediss://localhost:6380').tls).toBe(true);
  });

  it('rejects malformed urls and wrong schemes', () => {
    expect(() => parseRedisUrl('localhost:6379')).toThrow(RedisUrlError);
    expect(() => parseRedisUrl('http://localhost:6379')).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it('rejects a nonsense database index', () => {
    expect(() => parseRedisUrl('redis://localhost:6379/main')).toThrow(/database index/);
  });

  it('falls back to localhost for a host-less url', () => {
    // `new URL` accepts a bare `redis://`, and a misconfigured env should get a
    // useful default rather than a connection to "".
    expect(parseRedisUrl('redis://')).toMatchObject({ host: 'localhost', port: 6379, db: 0 });
  });
});

describe('toConnectionOptions', () => {
  it('blocks forever for producers so events queue up while Redis recovers', () => {
    const options = toConnectionOptions({
      url: 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    });
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it('fails fast for workers so a blocking read cannot hang forever', () => {
    const options = toConnectionOptions({ url: 'redis://localhost:6379', maxRetriesPerRequest: 0 });
    expect(options.maxRetriesPerRequest).toBe(0);
  });

  it('preserves the rest of the parsed options', () => {
    const options = toConnectionOptions({ url: 'rediss://cache:6380/2', maxRetriesPerRequest: 0 });
    expect(options).toMatchObject({ host: 'cache', port: 6380, db: 2, tls: true });
  });
});

describe('resolveRedisUrl', () => {
  it('defaults to localhost when nothing is configured', () => {
    expect(resolveRedisUrl({})).toBe('redis://localhost:6379');
  });

  it('builds a URL from discrete host and port properties', () => {
    expect(resolveRedisUrl({ REDIS_HOST: 'red-abc123', REDIS_PORT: '6380' })).toBe(
      'redis://red-abc123:6380',
    );
    expect(resolveRedisUrl({ REDIS_HOST: 'red-abc123' })).toBe('redis://red-abc123:6379');
  });

  it('prefers a valid explicit URL over host and port', () => {
    expect(
      resolveRedisUrl({
        REDIS_URL: 'rediss://user:pass@cache:6380/2',
        REDIS_HOST: 'red-abc123',
        REDIS_PORT: '6379',
      }),
    ).toBe('rediss://user:pass@cache:6380/2');
  });

  it('falls back to host and port when the explicit URL is unusable', () => {
    expect(
      resolveRedisUrl({
        REDIS_URL: 'not a url',
        REDIS_HOST: 'red-abc123',
        REDIS_PORT: '6379',
      }),
    ).toBe('redis://red-abc123:6379');
  });

  it('keeps an unusable URL when no host fallback exists', () => {
    expect(resolveRedisUrl({ REDIS_URL: 'not a url' })).toBe('not a url');
  });
});
