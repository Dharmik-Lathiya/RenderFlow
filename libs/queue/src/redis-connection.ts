/**
 * Redis connection options.
 *
 * BullMQ wants a shared connection for producers and separate, non-blocking
 * connections for each worker: a blocking `BRPOPLPUSH` on the worker connection
 * would stall every other command on that socket. Keeping the mapping in one
 * tested function avoids the classic "why is my worker's health check hanging"
 * bug.
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls: boolean;
  maxRetriesPerRequest: number | null;
  enableReadyCheck: boolean;
}

export interface RedisConnectionConfig {
  url: string;
  /** `null` means block forever - correct for queue producers. */
  maxRetriesPerRequest: number | null;
}

/**
 * @see redactConnectionUrl in @renderflow/common - shared with the logging
 * boundary so queue config and logs can never disagree about what is safe.
 */

export class RedisUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisUrlError';
  }
}

export function parseRedisUrl(url: string): RedisConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RedisUrlError(`REDIS_URL is not a valid URL: "${url}"`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RedisUrlError(`REDIS_URL must use redis:// or rediss://, received "${url}"`);
  }

  const dbSegment = parsed.pathname.replace(/^\//, '');
  const db = dbSegment === '' ? 0 : Number(dbSegment);
  if (!Number.isInteger(db) || db < 0) {
    throw new RedisUrlError(`REDIS_URL has an invalid database index: "${dbSegment}"`);
  }

  const options: RedisConnectionOptions = {
    host: parsed.hostname === '' ? 'localhost' : parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    db,
    tls: parsed.protocol === 'rediss:',
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };

  if (parsed.username !== '') {
    options.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password !== '') {
    options.password = decodeURIComponent(parsed.password);
  }

  return options;
}

/**
 * @param config null `maxRetriesPerRequest` for producers (wait forever for Redis)
 *              and `0` for workers so a blocking read fails fast instead of hanging.
 */
export function toConnectionOptions(config: RedisConnectionConfig): RedisConnectionOptions {
  const options = parseRedisUrl(config.url);
  return {
    ...options,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
  };
}
