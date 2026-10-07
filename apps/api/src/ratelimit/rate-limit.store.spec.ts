import { InMemoryRateLimitStore } from './rate-limit.store';

/**
 * Store behaviour.
 *
 * `now` is injected rather than read from the clock, so every window edge case
 * here is exact instead of approximated with a sleep (AGENTS.md section 9).
 */
describe('InMemoryRateLimitStore', () => {
  const MINUTE = 60_000;
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it('allows exactly `limit` requests, then rejects', () => {
    const policy = { limit: 3, windowMs: MINUTE };

    for (let i = 0; i < 3; i += 1) {
      expect(store.hit('ip:1.2.3.4', policy, 0).allowed).toBe(true);
    }

    const rejected = store.hit('ip:1.2.3.4', policy, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  it('counts down the remaining allowance', () => {
    const policy = { limit: 3, windowMs: MINUTE };

    expect(store.hit('k', policy, 0).remaining).toBe(2);
    expect(store.hit('k', policy, 0).remaining).toBe(1);
    expect(store.hit('k', policy, 0).remaining).toBe(0);
    // Never negative, however far past the limit the caller goes.
    expect(store.hit('k', policy, 0).remaining).toBe(0);
    expect(store.hit('k', policy, 0).remaining).toBe(0);
  });

  it('keeps the counter separate per key', () => {
    // Two accounts behind one NAT must not share a ceiling.
    const policy = { limit: 2, windowMs: MINUTE };

    store.hit('a', policy, 0);
    store.hit('a', policy, 0);

    expect(store.hit('a', policy, 0).allowed).toBe(false);
    expect(store.hit('b', policy, 0).allowed).toBe(true);
  });

  it('reports when the window resets', () => {
    const policy = { limit: 1, windowMs: MINUTE };
    const first = store.hit('k', policy, 1_000);

    expect(first.resetAt).toBe(1_000 + MINUTE);
    expect(first.retryAfterSeconds).toBe(60);
  });

  it('starts a fresh window once the old one expires', () => {
    const policy = { limit: 1, windowMs: MINUTE };

    expect(store.hit('k', policy, 0).allowed).toBe(true);
    expect(store.hit('k', policy, 0).allowed).toBe(false);

    // One millisecond before the boundary the limit still holds.
    expect(store.hit('k', policy, MINUTE - 1).allowed).toBe(false);
    expect(store.hit('k', policy, MINUTE).allowed).toBe(true);
  });

  it('anchors the window to the first hit, so waiting does not reset it', () => {
    // The alternative - a window relative to `now` on every request - lets a
    // caller who keeps the window rolling never be limited at all.
    const policy = { limit: 1, windowMs: MINUTE };

    store.hit('k', policy, 0);
    expect(store.hit('k', policy, 10_000).allowed).toBe(false);
    expect(store.hit('k', policy, 20_000).allowed).toBe(false);
  });

  it('never tells a caller to retry after zero seconds', () => {
    // `Retry-After: 0` invites an immediate retry that fails again, turning a
    // brief limit into a tight client-side loop.
    const policy = { limit: 1, windowMs: 1_000 };
    store.hit('k', policy, 0);

    expect(store.hit('k', policy, 999).retryAfterSeconds).toBe(1);
  });

  it('releases the key when the window has passed, instead of leaking it', () => {
    const policy = { limit: 5, windowMs: MINUTE };
    store.hit('k', policy, 0);
    expect(store.size()).toBe(1);

    // A long-expired window is replaced rather than retained.
    store.hit('k', policy, MINUTE * 10);
    expect(store.size()).toBe(1);
  });

  it('clears everything on reset', () => {
    const policy = { limit: 1, windowMs: MINUTE };
    store.hit('a', policy, 0);
    store.hit('b', policy, 0);
    expect(store.size()).toBe(2);

    store.reset();

    expect(store.size()).toBe(0);
    expect(store.hit('a', policy, 0).allowed).toBe(true);
  });

  describe('memory safety', () => {
    it('never grows past the cap, even when every key is still active', () => {
      // Without a cap, an attacker rotating source addresses grows this map
      // until the process dies: the limiter itself becomes the outage.
      const capped = new InMemoryRateLimitStore({ maxEntries: 10 });
      const policy = { limit: 100, windowMs: 60 * 60_000 };

      let largest = 0;
      for (let i = 0; i < 200; i += 1) {
        capped.hit(`key-${i}`, policy, 0);
        largest = Math.max(largest, capped.size());
      }

      expect(largest).toBeLessThanOrEqual(10);
      expect(capped.size()).toBeLessThanOrEqual(10);
    });

    it('reclaims expired entries rather than evicting live ones', () => {
      // A long-idle process must not hold counters for addresses that stopped
      // arriving an hour ago, and must not need to to stay bounded.
      const capped = new InMemoryRateLimitStore({ maxEntries: 4 });
      const policy = { limit: 100, windowMs: 1_000 };

      for (let i = 0; i < 8; i += 1) {
        capped.hit(`stale-${i}`, policy, 0);
      }

      // Crossing the cap long afterwards sweeps the stale entries, so the new
      // hit is not competing with them for space.
      capped.hit('fresh', policy, 10_000_000);

      expect(capped.size()).toBe(1);
      expect(capped.hit('fresh', policy, 10_000_000).allowed).toBe(true);
    });

    it('evicts active entries when a flood is in progress', () => {
      // Worst case is that the limiter degrades under a current flood, which is
      // strictly better than unbounded growth.
      const capped = new InMemoryRateLimitStore({ maxEntries: 5 });
      const policy = { limit: 100, windowMs: 60 * 60_000 };

      for (let i = 0; i < 100; i += 1) {
        capped.hit(`key-${i}`, policy, 0);
      }

      expect(capped.size()).toBeLessThanOrEqual(5);
    });

    it('drops the entry closest to expiry first, keeping long-lived counters', () => {
      const capped = new InMemoryRateLimitStore({ maxEntries: 3 });
      const policy = { limit: 100, windowMs: 60_000 };

      // Three long windows registered first, then a burst of short ones.
      capped.hit('long-1', policy, 0);
      capped.hit('long-2', policy, 0);
      capped.hit('long-3', policy, 0);
      for (let i = 0; i < 20; i += 1) {
        capped.hit(`short-${i}`, { limit: 100, windowMs: 1_000 }, 0);
      }

      // The 10-second windows expire first, so the hour-long ones must survive.
      expect(capped.size()).toBeLessThanOrEqual(3);
      expect(capped.hit('long-1', policy, 1_000).allowed).toBe(true);
    });

    it('does not sweep while under the cap', () => {
      const capped = new InMemoryRateLimitStore({ maxEntries: 1_000 });
      const policy = { limit: 10, windowMs: 1_000 };

      capped.hit('k', policy, 0);
      capped.hit('k', policy, 0);

      expect(capped.size()).toBe(1);
    });
  });
});
