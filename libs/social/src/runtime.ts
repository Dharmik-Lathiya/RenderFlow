import { ConcurrencyLimiter } from '@renderflow/ai';

import { PublishError, type SocialAdapter, type SocialPlatform } from './adapter';
import { MockSocialAdapter } from './mock-adapter';

/**
 * The publisher's runtime: per-platform rate limiting and token refresh.
 *
 * Split out from the adapter because these are OUR responsibilities, and an
 * adapter that rate-limits itself has to be trusted to do it correctly at
 * every call site.
 */

/**
 * Per-platform publish limiter.
 *
 * A fixed number of API calls per window per platform, because every one of
 * these platforms enforces a limit and exceeding it gets the whole app's tokens
 * throttled, not just the offending request. Concurrency AND a window: LinkedIn
 * rejects bursts even inside the daily quota.
 */
export class PlatformRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly platform: SocialPlatform,
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    concurrency = 2,
  ) {
    this.limiter = new ConcurrencyLimiter(concurrency);
  }

  /**
   * Waits for a slot, or refuses.
   *
   * Refuses rather than waiting when the window is full: a publish that waits
   * five minutes misses its scheduled slot, and a publisher that silently runs
   * late is worse than one that says it cannot go now.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.prune(Date.now());

    if (this.timestamps.length >= this.maxPerWindow) {
      throw new PublishError(
        `${this.platform} publish limit reached (${this.maxPerWindow} per ${this.windowMs}ms)`,
        'TRANSIENT',
        this.retryAfterMs(),
      );
    }

    return this.limiter.run(async () => {
      this.timestamps.push(Date.now());

      try {
        return await fn();
      } finally {
        // Recorded before the call, not after: a call that fails still consumed
        // a slot, and not counting it is how a rate limiter stops being one.
      }
    });
  }

  /** Milliseconds until the oldest call leaves the window. */
  retryAfterMs(): number {
    this.prune(Date.now());
    const oldest = this.timestamps[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + this.windowMs - Date.now());
  }

  private prune(now: number): void {
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) + this.windowMs <= now) {
      this.timestamps.shift();
    }
  }
}

/** How a platform's token set is renewed. */
export interface TokenRefresher {
  refresh(
    platform: SocialPlatform,
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date | null;
  }>;
}

export interface RefreshOutcome {
  refreshed: boolean;
  /** Present when `refreshed` is false. */
  reason?: string;
}

/**
 * Refreshes an expired token, exactly once.
 *
 * The "exactly once" is the point. A 401 arrives, three workers all retry, and
 * without a guard all three call the platform's refresh endpoint - which
 * invalidates the previous refresh token, so the second call fails and logs the
 * account out. The dedupe key is the publish job, because that is the unit two
 * workers would be duplicating.
 */
export class TokenRefresherRegistry {
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>();

  constructor(private readonly refresher: TokenRefresher) {}

  async refreshOnce(
    platform: SocialPlatform,
    refreshToken: string,
    dedupeKey: string,
  ): Promise<RefreshOutcome> {
    const existing = this.inFlight.get(dedupeKey);

    if (existing !== undefined) {
      return existing;
    }

    const attempt = this.attempt(platform, refreshToken).finally(() => {
      this.inFlight.delete(dedupeKey);
    });

    this.inFlight.set(dedupeKey, attempt);
    return attempt;
  }

  private async attempt(platform: SocialPlatform, refreshToken: string): Promise<RefreshOutcome> {
    if (refreshToken.trim() === '') {
      return { refreshed: false, reason: 'no refresh token; the account must reconnect' };
    }

    try {
      await this.refresher.refresh(platform, refreshToken);
      return { refreshed: true };
    } catch (error) {
      // A refresh failure is not itself a publish failure: the caller decides
      // whether to retry the publish or tell the user to reconnect. The reason
      // carries the underlying message because "token refresh failed" cannot be
      // told apart from a network blip, and the difference decides what happens
      // next. The refresh TOKEN is never in it - it comes from the environment,
      // not from the error.
      return {
        refreshed: false,
        reason: error instanceof Error ? error.message : `token refresh failed: ${String(error)}`,
      };
    }
  }
}

/** Builds an adapter for a platform from configuration. */
export function adapterFor(
  platform: SocialPlatform,
  options: { mock?: boolean; tokenExpired?: boolean } = {},
): SocialAdapter {
  // Real adapters arrive in a later commit; the factory exists now so the
  // publisher depends on the interface and not on the mock.
  void options;
  return new MockSocialAdapter({ platform });
}
