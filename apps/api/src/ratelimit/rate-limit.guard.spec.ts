import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';

import {
  RATE_LIMIT_RULES,
  RATE_LIMIT_STORE,
  PreAuthRateLimitGuard,
  RateLimit,
  RateLimitByIp,
  RateLimitByUser,
  RateLimitGuard,
  RateLimitedError,
  UserRateLimitGuard,
  setRateLimitHeaders,
  tightestDecision,
  type RateLimitScope,
} from './rate-limit.guard';
import { loadRateLimitConfig } from './rate-limit.config';
import {
  InMemoryRateLimitStore,
  type RateLimitDecision,
  type RateLimitStore,
} from './rate-limit.store';

/**
 * Guard behaviour.
 *
 * These tests exercise the decision path directly - which key a request maps to,
 * whether a 429 is raised, which headers are written - with a real in-memory
 * store behind it. The HTTP-level behaviour (real status, real headers, real
 * ordering against the other guards) is asserted in tests/integration.
 */

/** Minimal request stand-in; the guard reads only these three fields. */
interface FakeRequest {
  headers: Record<string, string | undefined>;
  ip?: string;
  body?: unknown;
  user?: { id: string };
}

function contextFor(request: FakeRequest, response: Response): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** A response double that records the headers the guard writes. */
function responseDouble(): Response & { setHeader: jest.Mock } {
  return { setHeader: jest.fn() } as unknown as Response & { setHeader: jest.Mock };
}

/**
 * Reflector stub.
 *
 * The guard reads route metadata through `Reflector`, which needs a real
 * decorated target to reflect on. Stubbing `getAllAndOverride` keeps each test
 * focused on the guard's decision rather than on Nest's decorator plumbing.
 */
function reflectorReturning(metadata: unknown): Reflector {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(metadata);
  return reflector;
}

/**
 * Config stub.
 *
 * `loadRateLimitConfig` expects a reader over an env-shaped record, which is
 * exactly what the real `ConfigService` presents to a `useFactory`.
 */
function configReader(env: Record<string, unknown>): { get: <T>(key: string) => T | undefined } {
  return { get: <T>(key: string): T | undefined => env[key] as T | undefined };
}

/** Guard + context wired together, the shape most tests need. */
function harness(options: {
  env: Record<string, unknown>;
  store: RateLimitStore;
  metadata: unknown;
  request: FakeRequest;
}): { guard: RateLimitGuard; context: ExecutionContext; response: Response } {
  const guard = new RateLimitGuard(
    reflectorReturning(options.metadata),
    loadRateLimitConfig(configReader(options.env)),
    options.store,
  );
  const response = responseDouble();

  return { guard, context: contextFor(options.request, response), response };
}

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return { headers: {}, ip: '203.0.113.7', ...overrides };
}

describe('RateLimitGuard', () => {
  describe('routes without a limit', () => {
    it('passes through when the route carries no metadata', async () => {
      // Opt-in by decorator: a new endpoint is never accidentally throttled by a
      // neighbour's rule, and never silently inherits one either.
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({
        env: {},
        store,
        metadata: undefined,
        request: request(),
      });

      expect(await guard.canActivate(context)).toBe(true);
      expect(store.size()).toBe(0);
    });

    it('passes through when the metadata list is empty', async () => {
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({ env: {}, store, metadata: [], request: request() });

      expect(await guard.canActivate(context)).toBe(true);
    });

    it('passes everything through when the master switch is off', async () => {
      // The documented escape hatch for load testing and incident response.
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: 'LOGIN_IP', scope: 'ip' }];

      for (let i = 0; i < 50; i += 1) {
        const { guard, context } = harness({
          env: { RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_LOGIN_IP: '1/1h' },
          store,
          metadata: rules,
          request: request(),
        });
        expect(await guard.canActivate(context)).toBe(true);
      }
      expect(store.size()).toBe(0);
    });
  });

  describe('rejecting', () => {
    it('allows up to the limit, then raises RATE_LIMITED', async () => {
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const }];
      const run = async (): Promise<boolean> => {
        const { guard, context } = harness({
          env: { RATE_LIMIT_LOGIN_IP: '2/15m' },
          store,
          metadata: rules,
          request: request(),
        });
        return guard.canActivate(context);
      };

      expect(await run()).toBe(true);
      expect(await run()).toBe(true);
      await expect(run()).rejects.toThrow(RateLimitedError);
    });

    it('raises an error the exception filter turns into a 429', async () => {
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const }];
      const setup = (): { guard: RateLimitGuard; context: ExecutionContext; response: Response } =>
        harness({
          env: { RATE_LIMIT_LOGIN_IP: '1/15m' },
          store,
          metadata: rules,
          request: request(),
        });

      // First hit spends the only slot.
      await setup().guard.canActivate(contextFor(request(), responseDouble()));

      const { guard, context } = setup();

      let thrown: unknown;
      try {
        await guard.canActivate(context);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RateLimitedError);
      const error = thrown as RateLimitedError;
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.httpStatus).toBe(429);
      expect(error.details).toMatchObject({ rule: 'LOGIN_IP', limit: 1 });
    });

    it('skips a rule explicitly configured to 0', async () => {
      // `0` means "disabled", not "reject everything".
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const }];

      for (let i = 0; i < 100; i += 1) {
        const { guard, context } = harness({
          env: { RATE_LIMIT_LOGIN_IP: '0' },
          store,
          metadata: rules,
          request: request(),
        });
        expect(await guard.canActivate(context)).toBe(true);
      }
    });
  });

  describe('key derivation', () => {
    /** Number of distinct keys the guard created after N requests. */
    async function keysAfter(
      env: Record<string, unknown>,
      rules: Array<{ name: string; scope: RateLimitScope }>,
      requests: FakeRequest[],
    ): Promise<number> {
      const store = new InMemoryRateLimitStore();
      for (const req of requests) {
        const { guard, context } = harness({ env, store, metadata: rules, request: req });
        try {
          await guard.canActivate(context);
        } catch {
          // A rejection is expected on the requests that breach the limit.
        }
      }
      return store.size();
    }

    it('separates callers by IP', async () => {
      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [request({ ip: '1.1.1.1' }), request({ ip: '2.2.2.2' })],
        ),
      ).toBe(2);
    });

    it('keys by the address Express resolved behind a trusted proxy', async () => {
      // `main.ts` sets `trust proxy`, so Express turns X-Forwarded-For into
      // `req.ip`. Keying on the socket address instead would put every user of
      // the internet in one bucket; parsing the raw header in the guard would
      // let the caller choose their bucket.
      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [request({ ip: '198.51.100.9' })],
        ),
      ).toBe(1);
      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [request({ ip: '198.51.100.9' }), request({ ip: '203.0.113.4' })],
        ),
      ).toBe(2);
    });

    it('keys per-user routes by the authenticated id', async () => {
      // This is the "per-user API limits" PROJECT.md section 14 asks for.
      expect(
        await keysAfter(
          { RATE_LIMIT_REFRESH_IP: '10/15m' },
          [{ name: 'REFRESH_IP', scope: 'user' }],
          [
            request({ user: { id: 'user-a' } }),
            request({ user: { id: 'user-a' } }),
            request({ user: { id: 'user-b' } }),
          ],
        ),
      ).toBe(2);
    });

    it('falls back to the IP when a user-scoped route has no session', async () => {
      expect(
        await keysAfter(
          { RATE_LIMIT_REFRESH_IP: '10/15m' },
          [{ name: 'REFRESH_IP', scope: 'user' }],
          [request({ ip: '5.5.5.5' }), request({ ip: '6.6.6.6' })],
        ),
      ).toBe(2);
    });

    it('normalises the submitted email so casing and padding cannot evade it', async () => {
      // Without normalisation an attacker could reset the counter with
      // `victim@x.com`, `Victim@X.com` and ` victim@x.com `, and a limit that
      // can be evaded that easily is not a limit.
      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
          [{ name: 'LOGIN_ACCOUNT', scope: 'email' }],
          [
            request({ body: { email: 'victim@example.com' } }),
            request({ body: { email: 'VICTIM@example.com' } }),
            request({ body: { email: '  victim@EXAMPLE.com  ' } }),
          ],
        ),
      ).toBe(1);
    });

    it('keeps distinct emails on distinct counters', async () => {
      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
          [{ name: 'LOGIN_ACCOUNT', scope: 'email' }],
          [
            request({ body: { email: 'a@example.com' } }),
            request({ body: { email: 'b@example.com' } }),
          ],
        ),
      ).toBe(2);
    });

    it('falls back to the IP when the body carries no email', async () => {
      // Bounds the key space: garbage bodies must not mint unbounded keys.
      const requests = [
        request({ body: {} }),
        request({ body: { email: '' } }),
        request({ body: { email: 42 } }),
        request({ body: null }),
        request({ body: 'not-an-object' }),
      ];

      expect(
        await keysAfter(
          { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
          [{ name: 'LOGIN_ACCOUNT', scope: 'email' }],
          requests,
        ),
      ).toBe(1);
    });

    it('caps the email key length', async () => {
      const long = `${'a'.repeat(1_000)}@example.com`;
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({
        env: { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
        store,
        metadata: [{ name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' }],
        request: request({ body: { email: long } }),
      });

      await guard.canActivate(context);

      expect(store.size()).toBe(1);
    });
  });

  describe('multiple rules on one route', () => {
    it('counts each rule separately and reports the one that rejected', async () => {
      // Login carries an IP limit and an account limit; the 429 must name which.
      const store = new InMemoryRateLimitStore();
      const rules = [
        { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const },
        { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' as const },
      ];
      const body = { email: 'a@example.com' };
      const run = async (): Promise<void> => {
        await harness({
          env: { RATE_LIMIT_LOGIN_IP: '100/15m', RATE_LIMIT_LOGIN_ACCOUNT: '1/1h' },
          store,
          metadata: rules,
          request: request({ body }),
        }).guard.canActivate(contextFor(request({ body }), responseDouble()));
      };

      await run();

      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }

      expect((thrown as RateLimitedError).rule).toBe('LOGIN_ACCOUNT');
    });

    it('stops at the first rule that rejects, so later rules are not charged', async () => {
      // Charging a rule whose request was already refused would let a caller
      // exhaust the per-account allowance with IP-blocked requests.
      const store = new InMemoryRateLimitStore();
      const rules = [
        { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const },
        { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' as const },
      ];
      const body = { email: 'a@example.com' };
      const run = async (): Promise<void> => {
        await harness({
          env: { RATE_LIMIT_LOGIN_IP: '1/15m', RATE_LIMIT_LOGIN_ACCOUNT: '100/1h' },
          store,
          metadata: rules,
          request: request({ body }),
        }).guard.canActivate(contextFor(request({ body }), responseDouble()));
      };

      // First request is within both limits: the IP slot and the account slot are
      // both spent by exactly one call each.
      await run();

      // Every request after that is blocked by the IP rule. The account rule
      // must never be reached, or a caller who is already IP-blocked could
      // still exhaust the per-account allowance using requests that were
      // refused.
      for (let i = 0; i < 5; i += 1) {
        await expect(run()).rejects.toThrow(RateLimitedError);
      }

      // Read the account counter directly: it must still show a single hit.
      const accountKey = 'LOGIN_ACCOUNT:a@example.com';
      const afterRejections = await store.hit(
        accountKey,
        { limit: 100, windowMs: 3_600_000 },
        Date.now(),
      );

      expect(afterRejections.remaining).toBe(98);
    });
  });

  describe('headers', () => {
    it('writes limit, remaining and reset on an allowed request', async () => {
      const store = new InMemoryRateLimitStore();
      const { guard, context, response } = harness({
        env: { RATE_LIMIT_LOGIN_IP: '10/15m' },
        store,
        metadata: [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' }],
        request: request(),
      });

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '10');
      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '9');
      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
      expect(response.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    });

    it('adds Retry-After when rejecting', async () => {
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const }];
      const setup = (): { guard: RateLimitGuard; context: ExecutionContext; response: Response } =>
        harness({
          env: { RATE_LIMIT_LOGIN_IP: '1/15m' },
          store,
          metadata: rules,
          request: request(),
        });

      // First hit spends the only slot.
      await setup().guard.canActivate(contextFor(request(), responseDouble()));

      const { guard, context, response } = setup();
      await expect(guard.canActivate(context)).rejects.toThrow(RateLimitedError);

      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });
  });

  describe('decorators', () => {
    /** `SetMetadata` writes onto the target, so read it back off a method. */
    function metadataFor(decorate: (target: object, key: string) => void): unknown {
      class Target {
        handler(): void {
          // Metadata only.
        }
      }
      decorate(Target.prototype, 'handler');
      return Reflect.getMetadata('renderflow:rateLimits', Target.prototype);
    }

    it('RateLimitByIp records the rule and scope', async () => {
      expect(metadataFor(RateLimitByIp(RATE_LIMIT_RULES.REGISTER_IP))).toEqual([
        { name: 'REGISTER_IP', scope: 'ip' },
      ]);
    });

    it('RateLimitByUser records the user scope', async () => {
      expect(metadataFor(RateLimitByUser(RATE_LIMIT_RULES.REFRESH_IP))).toEqual([
        { name: 'REFRESH_IP', scope: 'user' },
      ]);
    });

    it('RateLimit accepts several rules', async () => {
      const decorate = RateLimit(
        { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' },
        { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' },
      );

      expect(metadataFor(decorate as (target: object, key: string) => void)).toEqual([
        { name: 'LOGIN_IP', scope: 'ip' },
        { name: 'LOGIN_ACCOUNT', scope: 'email' },
      ]);
    });
  });
});

describe('tightestDecision', () => {
  const decision = (limit: number, remaining: number): RateLimitDecision => ({
    allowed: remaining > 0,
    limit,
    remaining,
    resetAt: 0,
    retryAfterSeconds: 1,
  });

  it('compares the fraction of budget left, not the raw count', async () => {
    // Login runs an IP rule and an account rule with very different budgets.
    // Reporting "30 remaining" from the generous one while 1 of 2 is left on the
    // tight one would tell the client it has room when it does not.
    expect(tightestDecision([decision(2, 1), decision(30, 29)]).limit).toBe(2);
    expect(tightestDecision([decision(30, 29), decision(2, 1)]).limit).toBe(2);
  });

  it('ignores disabled rules', async () => {
    expect(tightestDecision([decision(0, 0), decision(5, 4)]).limit).toBe(5);
    expect(tightestDecision([decision(5, 4), decision(0, 0)]).limit).toBe(5);
  });

  it('keeps the first when two are equally tight', async () => {
    expect(tightestDecision([decision(10, 5), decision(20, 10)]).limit).toBe(10);
  });
});

describe('setRateLimitHeaders', () => {
  it('writes the three standard headers', async () => {
    const setHeader = jest.fn();
    setRateLimitHeaders({ setHeader } as unknown as Response, {
      allowed: true,
      limit: 60,
      remaining: 59,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
    });

    expect(setHeader).toHaveBeenCalledWith('RateLimit-Limit', '60');
    expect(setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '59');
  });

  it('omits Retry-After for an allowed request', async () => {
    const setHeader = jest.fn();
    setRateLimitHeaders({ setHeader } as unknown as Response, {
      allowed: true,
      limit: 60,
      remaining: 1,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
    });

    expect(setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
  });

  it('never reports a negative reset time', async () => {
    // A window that has already elapsed must not produce `RateLimit-Reset: -1`.
    const setHeader = jest.fn();
    setRateLimitHeaders({ setHeader } as unknown as Response, {
      allowed: true,
      limit: 5,
      remaining: 0,
      resetAt: Date.now() - 10_000,
      retryAfterSeconds: 1,
    });

    const call = setHeader.mock.calls.find(([name]) => name === 'RateLimit-Reset');
    expect(Number(call?.[1])).toBeGreaterThanOrEqual(0);
  });
});

describe('store injection token', () => {
  it('is a symbol, so it cannot collide with a class token', async () => {
    expect(typeof RATE_LIMIT_STORE).toBe('symbol');
  });
});

/**
 * The two-phase split.
 *
 * `user` scope needs `request.user`, which the pre-auth guard runs too early to
 * see. Before the split it fell back to the IP, so an office of ten shared one
 * generation budget while each of them was told the limit was theirs.
 */
describe('guard phases', () => {
  it('the pre-auth guard leaves user rules to the post-auth guard', async () => {
    const store = new InMemoryRateLimitStore();
    const guard = new PreAuthRateLimitGuard(
      reflectorReturning([{ name: RATE_LIMIT_RULES.GENERATE_USER, scope: 'user' }]),
      loadRateLimitConfig(configReader({})),
      store,
    );

    const allowed = await guard.canActivate(
      contextFor(request({ user: { id: 'user-a' } }), responseDouble()),
    );

    expect(allowed).toBe(true);
    // Nothing counted: this instance does not own the rule.
    expect(store.size()).toBe(0);
  });

  it('the post-auth guard counts per user, not per address', async () => {
    const store = new InMemoryRateLimitStore();
    const guard = new UserRateLimitGuard(
      reflectorReturning([{ name: RATE_LIMIT_RULES.GENERATE_USER, scope: 'user' }]),
      loadRateLimitConfig(configReader({ RATE_LIMIT_GENERATE_USER: '1/1h' })),
      store,
    );

    const pass = (user: string): Promise<boolean> =>
      guard.canActivate(
        contextFor(request({ ip: '203.0.113.9', user: { id: user } }), responseDouble()),
      );

    expect(await pass('user-a')).toBe(true);
    await expect(pass('user-a')).rejects.toThrow(RateLimitedError);

    // A colleague behind the same NAT has their own budget.
    expect(await pass('user-b')).toBe(true);
  });

  it('the post-auth guard ignores ip rules', async () => {
    const store = new InMemoryRateLimitStore();
    const guard = new UserRateLimitGuard(
      reflectorReturning([{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' }]),
      loadRateLimitConfig(configReader({ RATE_LIMIT_LOGIN_IP: '1/15m' })),
      store,
    );

    expect(await guard.canActivate(contextFor(request(), responseDouble()))).toBe(true);
    expect(store.size()).toBe(0);
  });
});
