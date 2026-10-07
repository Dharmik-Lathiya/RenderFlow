import type { RateLimitPolicy } from './rate-limit.config';

/**
 * Rate limit accounting.
 *
 * An interface rather than a concrete class because the counter is per-process
 * and therefore only correct for a single API instance. `REDIS_URL` is already
 * configured, so a shared store can be added later without touching call sites -
 * but wiring Redis into the API's boot path would make a resilience mechanism
 * into a startup dependency, so that trade is deferred deliberately.
 *
 * KNOWN LIMITATION: with N API instances the effective ceiling is N x the
 * configured limit. That is a weakening, not a hole - it cannot make the limit
 * stricter than configured - and it is the correct trade while the API runs as a
 * single instance. Revisit before the first horizontal scale-out.
 */

export interface RateLimitDecision {
  /** False means the request must be rejected with 429. */
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number;
  /** Seconds until reset. Rounded up so `Retry-After: 0` is never emitted. */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /**
   * Records one hit and reports whether it is within the limit.
   *
   * `now` is passed in rather than read from the clock so the logic is testable
   * without sleeping (AGENTS.md section 9).
   */
  hit(key: string, policy: RateLimitPolicy, now: number): RateLimitDecision;
  /** Drops all counters. Used between integration tests. */
  reset(): void;
  /** Live entry count. Exposed so the memory-safety test can assert on it. */
  size(): number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface InMemoryStoreOptions {
  /**
   * Hard ceiling on tracked keys.
   *
   * Without it, an attacker rotating source addresses grows the map until the
   * process dies - the limiter would become the outage. On overflow the store
   * evicts rather than rejecting, so the worst case is that a flood degrades the
   * limiter instead of the API.
   */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxEntries: number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  hit(key: string, policy: RateLimitPolicy, now: number): RateLimitDecision {
    const existing = this.buckets.get(key);

    // Window is derived from the *first* hit in it, so the count cannot be reset
    // by simply waiting: the boundary is anchored to bucket creation.
    const bucket =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + policy.windowMs }
        : existing;

    bucket.count += 1;
    this.buckets.set(key, bucket);
    // Swept against the caller's clock, not `Date.now()`: the store's whole
    // contract is that `now` is supplied, and consulting a second clock here
    // would make eviction depend on wall time the caller never controls.
    this.enforceCap(now);

    const allowed = bucket.count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: bucket.resetAt,
      // Ceiling so a client told to retry "0 seconds" never immediately fails
      // again on the same boundary.
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  /**
   * Keeps the map bounded.
   *
   * Sweeps expired entries first, because that reclaims everything except the
   * genuinely active window. Only if that is not enough - i.e. the flood is
   * *current* - does it evict the entries closest to expiry.
   */
  private enforceCap(now: number): void {
    if (this.buckets.size <= this.maxEntries) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }

    if (this.buckets.size <= this.maxEntries) {
      return;
    }

    const byExpiry = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < byExpiry.length - this.maxEntries; i += 1) {
      const entry = byExpiry[i];
      if (entry !== undefined) {
        this.buckets.delete(entry[0]);
      }
    }
  }
}
