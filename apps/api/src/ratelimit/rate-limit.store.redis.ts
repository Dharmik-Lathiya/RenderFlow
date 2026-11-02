import Redis from 'ioredis';
import type { OnModuleDestroy } from '@nestjs/common';

import { connectionOptionsFor } from '@renderflow/queue';
import { createLogger } from '@renderflow/observability';

import type { RateLimitPolicy } from './rate-limit.config';
import type { RateLimitDecision, RateLimitStore } from './rate-limit.store';

/**
 * Redis-backed rate limit store.
 *
 * The in-memory store counts per process, so with N API replicas the effective
 * ceiling is N x the configured limit. That is fine for one instance and wrong
 * the moment the API scales horizontally - a login attacker just spreads across
 * replicas. This store moves the counter into Redis so every replica shares one
 * budget.
 *
 * The increment and the TTL are one Lua script, not `INCR` followed by
 * `EXPIRE`: two round trips leave a window where a crash (or a second replica)
 * can create a key with no expiry, which would permanently lock a caller out.
 * The script also returns `PTTL` in the same round trip, so the headers describe
 * the real window instead of a fresh one invented by the caller.
 *
 * Availability trade: if Redis is unreachable the request is ALLOWED, not
 * rejected. A rate limiter protects the service; failing closed would turn a
 * Redis outage into a full API outage for every user. Failures are logged at a
 * throttled rate so an outage is visible without flooding the log.
 */

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
return {count, pttl}
`;

/** Namespace so rate limit counters cannot collide with BullMQ or app keys. */
const KEY_PREFIX = 'renderflow:ratelimit:';

/** At most one outage warning per minute, however many requests fail. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

let logger: ReturnType<typeof createLogger> | null = null;

/** Wires the logger at boot. Called once from the rate limit module. */
export function configureRateLimitLogger(instance: ReturnType<typeof createLogger>): void {
  logger = instance;
}

function log(): ReturnType<typeof createLogger> {
  logger ??= createLogger({ service: 'ratelimit' });
  return logger;
}

export class RedisRateLimitStore implements RateLimitStore, OnModuleDestroy {
  private readonly client: Redis;
  private readonly connection: Promise<void>;
  private lastFailureLogAt = 0;

  constructor(redisUrl: string) {
    // Reuse the queue's URL/TLS parsing so `redis://user:pass@host:6379/2` and
    // `rediss://` behave identically everywhere. Its `maxRetriesPerRequest:
    // null` is BullMQ's blocking-command default; a limiter must fail fast
    // instead of hanging a request, so that one value is replaced below.
    const {
      tls,
      maxRetriesPerRequest: _queueRetries,
      ...connection
    } = connectionOptionsFor({
      redisUrl,
    });
    this.client = new Redis({
      ...connection,
      ...(tls ? { tls: {} } : {}),
      // Never queue commands while disconnected. A store that buffers during an
      // outage delivers a burst the moment Redis reconnects, which is exactly
      // the traffic spike a rate limiter exists to prevent.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // Bound the first handshake: a request must not wait the ioredis default
      // of ten seconds just to find out Redis is down.
      connectTimeout: 1_000,
      lazyConnect: true,
    });
    // ioredis emits `error`; without a listener Node treats it as unhandled and
    // the process exits. The connection errors are already handled per request.
    this.client.on('error', () => undefined);
    // Connect at boot rather than on the first request: the first login of the
    // day should not pay for the handshake, and a bad REDIS_URL should show up
    // in the startup logs rather than as one slow request.
    this.connection = this.client.connect().catch(() => undefined);
  }

  async hit(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision> {
    // A command issued while the socket is still connecting is rejected by
    // `enableOfflineQueue: false`. Wait for that first handshake (bounded by
    // `connectTimeout`) so a cold replica applies the limit instead of
    // silently allowing its first few requests. Once the handshake has failed,
    // commands fail fast and the path below degrades.
    if (this.client.status !== 'ready') {
      await this.connection;
    }

    if (this.client.status !== 'ready') {
      return this.allow(policy, now);
    }

    try {
      const result = await this.client.eval(
        INCREMENT_SCRIPT,
        1,
        `${KEY_PREFIX}${key}`,
        String(policy.windowMs),
      );

      const [count, ttlMs] = parseScriptResult(result, policy.windowMs);
      const resetAt = now + ttlMs;

      return {
        allowed: count <= policy.limit,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - count),
        resetAt,
        // Ceiling so a client told to retry "0 seconds" never immediately fails
        // again on the same boundary.
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch (error) {
      this.logFailure(error);
      return this.allow(policy, now);
    }
  }

  /**
   * The degraded decision: allow, reporting the full budget because no shared
   * counter was observed. See the class comment for why this is not "fail
   * closed".
   */
  private allow(policy: RateLimitPolicy, now: number): RateLimitDecision {
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit,
      resetAt: now + policy.windowMs,
      retryAfterSeconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
    };
  }

  /**
   * Does not flush Redis keys.
   *
   * `reset()` is a test seam for the in-memory store. Deleting `ratelimit:*`
   * here would wipe counters for every replica (and for unrelated test runs
   * sharing the database), so callers that need isolation must use a unique key
   * prefix or the in-memory store instead.
   */
  reset(): void {
    // Intentionally empty.
  }

  /**
   * Redis cannot answer synchronously, and `size()` exists only for the
   * in-memory store's memory-safety assertion. Returning 0 keeps the interface
   * honest rather than adding a blocking call to a request path.
   */
  size(): number {
    return 0;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private logFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastFailureLogAt = now;
    log().warn(
      {
        event: 'RATE_LIMIT_STORE_UNAVAILABLE',
        error: error instanceof Error ? error.message : String(error),
      },
      'Redis rate limit store unavailable; allowing requests until it recovers',
    );
  }
}

/**
 * Lua returns an array of integers, but a mocked or proxied client may hand back
 * strings. Normalise both, and fall back to the configured window when the TTL
 * is missing or non-positive (a key that expired between `INCR` and `PTTL`).
 */
function parseScriptResult(result: unknown, windowMs: number): [count: number, ttlMs: number] {
  const values = Array.isArray(result) ? result : [];
  const count = Number(values[0]);
  const ttl = Number(values[1]);

  return [
    Number.isFinite(count) && count >= 0 ? count : 0,
    Number.isFinite(ttl) && ttl > 0 ? ttl : windowMs,
  ];
}
