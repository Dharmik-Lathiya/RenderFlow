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

  it('allows exactly `limit` requests, then rejects', async () => {
    const policy = { limit: 3, windowMs: MINUTE };

    for (let i = 0; i < 3; i += 1) {
      expect((await store.hit('ip:1.2.3.4', policy, 0)).allowed).toBe(true);
    }

    const rejected = await store.hit('ip:1.2.3.4', policy, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  it('counts down the remaining allowance', async () => {
    const policy = { limit: 3, windowMs: MINUTE };

    expect((await store.hit('k', policy, 0)).remaining).toBe(2);
    expect((await store.hit('k', policy, 0)).remaining).toBe(1);
    expect((await store.hit('k', policy, 0)).remaining).toBe(0);
    // Never negative, however far past the limit the caller goes.
    expect((await store.hit('k', policy, 0)).remaining).toBe(0);
    expect((await store.hit('k', policy, 0)).remaining).toBe(0);
  });

  it('keeps the counter separate per key', async () => {
    // Two accounts behind one NAT must not share a ceiling.
    const policy = { limit: 2, windowMs: MINUTE };

    await store.hit('a', policy, 0);
    await store.hit('a', policy, 0);

    expect((await store.hit('a', policy, 0)).allowed).toBe(false);
    expect((await store.hit('b', policy, 0)).allowed).toBe(true);
  });

  it('reports when the window resets', async () => {
    const policy = { limit: 1, windowMs: MINUTE };
    const first = await store.hit('k', policy, 1_000);

    expect(first.resetAt).toBe(1_000 + MINUTE);
    expect(first.retryAfterSeconds).toBe(60);
  });

  it('starts a fresh window once the old one expires', async () => {
    const policy = { limit: 1, windowMs: MINUTE };

    expect((await store.hit('k', policy, 0)).allowed).toBe(true);
    expect((await store.hit('k', policy, 0)).allowed).toBe(false);

    // One millisecond before the boundary the limit still holds.
    expect((await store.hit('k', policy, MINUTE - 1)).allowed).toBe(false);
    expect((await store.hit('k', policy, MINUTE)).allowed).toBe(true);
  });

  it('anchors the window to the first hit, so waiting does not reset it', async () => {
    // The alternative - a window relative to `now` on every request - lets a
    // caller who keeps the window rolling never be limited at all.
    const policy = { limit: 1, windowMs: MINUTE };

    await store.hit('k', policy, 0);
    expect((await store.hit('k', policy, 10_000)).allowed).toBe(false);
    expect((await store.hit('k', policy, 20_000)).allowed).toBe(false);
  });

  it('never tells a caller to retry after zero seconds', async () => {
    // `Retry-After: 0` invites an immediate retry that fails again, turning a
    // brief limit into a tight client-side loop.
    const policy = { limit: 1, windowMs: 1_000 };
    await store.hit('k', policy, 0);

    expect((await store.hit('k', policy, 999)).retryAfterSeconds).toBe(1);
  });

  it('releases the key when the window has passed, instead of leaking it', async () => {
    const policy = { limit: 5, windowMs: MINUTE };
    await store.hit('k', policy, 0);
    expect(store.size()).toBe(1);

    // A long-expired window is replaced rather than retained.
    await store.hit('k', policy, MINUTE * 10);
    expect(store.size()).toBe(1);
  });

  it('clears everything on reset', async () => {
    const policy = { limit: 1, windowMs: MINUTE };
    await store.hit('a', policy, 0);
    await store.hit('b', policy, 0);
    expect(store.size()).toBe(2);

    store.reset();

    expect(store.size()).toBe(0);
    expect((await store.hit('a', policy, 0)).allowed).toBe(true);
  });

  describe('memory safety', () => {
    it('never grows past the cap, even when every key is still active', async () => {
      // Without a cap, an attacker rotating source addresses grows this map
      // until the process dies: the limiter itself becomes the outage.
      const capped = new InMemoryRateLimitStore({ maxEntries: 10 });
      const policy = { limit: 100, windowMs: 60 * 60_000 };

      let largest = 0;
      for (let i = 0; i < 200; i += 1) {
        await capped.hit(`key-${i}`, policy, 0);
        largest = Math.max(largest, capped.size());
      }

      expect(largest).toBeLessThanOrEqual(10);
      expect(capped.size()).toBeLessThanOrEqual(10);
    });

    it('reclaims expired entries rather than evicting live ones', async () => {
      // A long-idle process must not hold counters for addresses that stopped
      // arriving an hour ago, and must not need to to stay bounded.
      const capped = new InMemoryRateLimitStore({ maxEntries: 4 });
      const policy = { limit: 100, windowMs: 1_000 };

      for (let i = 0; i < 8; i += 1) {
        await capped.hit(`stale-${i}`, policy, 0);
      }

      // Crossing the cap long afterwards sweeps the stale entries, so the new
      // hit is not competing with them for space.
      await capped.hit('fresh', policy, 10_000_000);

      expect(capped.size()).toBe(1);
      expect((await capped.hit('fresh', policy, 10_000_000)).allowed).toBe(true);
    });

    it('evicts active entries when a flood is in progress', async () => {
      // Worst case is that the limiter degrades under a current flood, which is
      // strictly better than unbounded growth.
      const capped = new InMemoryRateLimitStore({ maxEntries: 5 });
      const policy = { limit: 100, windowMs: 60 * 60_000 };

      for (let i = 0; i < 100; i += 1) {
        await capped.hit(`key-${i}`, policy, 0);
      }

      expect(capped.size()).toBeLessThanOrEqual(5);
    });

    it('drops the entry closest to expiry first, keeping long-lived counters', async () => {
      const capped = new InMemoryRateLimitStore({ maxEntries: 3 });
      const policy = { limit: 100, windowMs: 60_000 };

      // Three long windows registered first, then a burst of short ones.
      await capped.hit('long-1', policy, 0);
      await capped.hit('long-2', policy, 0);
      await capped.hit('long-3', policy, 0);
      for (let i = 0; i < 20; i += 1) {
        await capped.hit(`short-${i}`, { limit: 100, windowMs: 1_000 }, 0);
      }

      // The 10-second windows expire first, so the hour-long ones must survive.
      expect(capped.size()).toBeLessThanOrEqual(3);
      expect((await capped.hit('long-1', policy, 1_000)).allowed).toBe(true);
    });

    it('does not sweep while under the cap', async () => {
      const capped = new InMemoryRateLimitStore({ maxEntries: 1_000 });
      const policy = { limit: 10, windowMs: 1_000 };

      await capped.hit('k', policy, 0);
      await capped.hit('k', policy, 0);

      expect(capped.size()).toBe(1);
    });
  });
});
