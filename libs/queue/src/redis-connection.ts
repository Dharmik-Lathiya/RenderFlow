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

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

function readEnvString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const REDIS_SCHEME_RE = /^(redis|rediss):\/\//i;
// Preserve valid %XX escapes; encode everything else that URL rejects in userinfo.
const UNSAFE_USER_INFO_RE = /%[0-9a-f]{2}|[^A-Za-z0-9\-._~]/gi;

function encodeRedisUserInfo(value: string): string {
  return value.replace(UNSAFE_USER_INFO_RE, (token) =>
    /^%[0-9a-f]{2}$/i.test(token) ? token : encodeURIComponent(token),
  );
}

/**
 * Some providers (including Render Key Value) return a `connectionString` whose
 * password contains raw `/`, `+`, `=` or `@`. `new URL()` rejects that, even
 * though ioredis is happy with the literal password. Re-encode only the userinfo
 * before handing the string to the URL parser; the last `@` is the real host
 * separator, so raw `@` in a password is handled too.
 */
function parseWithEncodedUserInfo(url: string): URL | undefined {
  const match = REDIS_SCHEME_RE.exec(url);
  if (!match) {
    return undefined;
  }
  const scheme = (match[1] ?? 'redis').toLowerCase();
  const rest = url.slice(match[0].length);

  for (let at = rest.lastIndexOf('@'); at >= 0; at = rest.lastIndexOf('@', at - 1)) {
    const userinfo = rest.slice(0, at);
    const remainder = rest.slice(at + 1);
    const colon = userinfo.indexOf(':');
    const username = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const password = colon === -1 ? '' : userinfo.slice(colon + 1);
    const encoded =
      colon === -1
        ? encodeRedisUserInfo(username)
        : `${encodeRedisUserInfo(username)}:${encodeRedisUserInfo(password)}`;

    try {
      const parsed = new URL(`${scheme}://${encoded}@${remainder}`);
      if (parsed.protocol === `${scheme}:`) {
        return parsed;
      }
    } catch {
      // An earlier '@' may be the real separator; keep looking.
    }
  }

  return undefined;
}

/**
 * Resolve the Redis URL from `REDIS_URL`.
 *
 * Discrete `REDIS_HOST`/`REDIS_PORT` values win whenever present. Render injects
 * them from the Key Value service, and Render preserves old environment
 * variables when a Blueprint sync removes them - so a stale `REDIS_URL` from an
 * earlier deploy must not be allowed to shadow the provider-managed host/port.
 * `REDIS_URL` remains the normal configuration for local/Compose and providers
 * that only expose a full connection string.
 */
export function resolveRedisUrl(source: Record<string, unknown> = process.env): string {
  const host = readEnvString(source, 'REDIS_HOST');
  if (host !== undefined) {
    const port = readEnvString(source, 'REDIS_PORT') ?? '6379';
    return `redis://${host}:${port}`;
  }

  return readEnvString(source, 'REDIS_URL') ?? DEFAULT_REDIS_URL;
}

export function parseRedisUrl(url: string): RedisConnectionOptions {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }

  if (parsed && parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RedisUrlError(`REDIS_URL must use redis:// or rediss://, received "${url}"`);
  }

  parsed ??= parseWithEncodedUserInfo(url);
  if (!parsed) {
    throw new RedisUrlError(`REDIS_URL is not a valid URL: "${url}"`);
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
