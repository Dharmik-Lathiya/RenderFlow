import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';

import {
  RATE_LIMIT_RULES,
  RATE_LIMIT_STORE,
  RateLimit,
  RateLimitByIp,
  RateLimitByUser,
  RateLimitGuard,
  RateLimitedError,
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
    it('passes through when the route carries no metadata', () => {
      // Opt-in by decorator: a new endpoint is never accidentally throttled by a
      // neighbour's rule, and never silently inherits one either.
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({
        env: {},
        store,
        metadata: undefined,
        request: request(),
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(store.size()).toBe(0);
    });

    it('passes through when the metadata list is empty', () => {
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({ env: {}, store, metadata: [], request: request() });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('passes everything through when the master switch is off', () => {
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
        expect(guard.canActivate(context)).toBe(true);
      }
      expect(store.size()).toBe(0);
    });
  });

  describe('rejecting', () => {
    it('allows up to the limit, then raises RATE_LIMITED', () => {
      const store = new InMemoryRateLimitStore();
      const rules = [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const }];
      const run = (): boolean => {
        const { guard, context } = harness({
          env: { RATE_LIMIT_LOGIN_IP: '2/15m' },
          store,
          metadata: rules,
          request: request(),
        });
        return guard.canActivate(context);
      };

      expect(run()).toBe(true);
      expect(run()).toBe(true);
      expect(run).toThrow(RateLimitedError);
    });

    it('raises an error the exception filter turns into a 429', () => {
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
      setup().guard.canActivate(contextFor(request(), responseDouble()));

      const { guard, context } = setup();

      let thrown: unknown;
      try {
        guard.canActivate(context);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RateLimitedError);
      const error = thrown as RateLimitedError;
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.httpStatus).toBe(429);
      expect(error.details).toMatchObject({ rule: 'LOGIN_IP', limit: 1 });
    });

    it('skips a rule explicitly configured to 0', () => {
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
        expect(guard.canActivate(context)).toBe(true);
      }
    });
  });

  describe('key derivation', () => {
    /** Number of distinct keys the guard created after N requests. */
    function keysAfter(
      env: Record<string, unknown>,
      rules: Array<{ name: string; scope: RateLimitScope }>,
      requests: FakeRequest[],
    ): number {
      const store = new InMemoryRateLimitStore();
      for (const req of requests) {
        const { guard, context } = harness({ env, store, metadata: rules, request: req });
        try {
          guard.canActivate(context);
        } catch {
          // A rejection is expected on the requests that breach the limit.
        }
      }
      return store.size();
    }

    it('separates callers by IP', () => {
      expect(
        keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [request({ ip: '1.1.1.1' }), request({ ip: '2.2.2.2' })],
        ),
      ).toBe(2);
    });

    it('prefers the left-most forwarded address over the socket address', () => {
      // Behind a trusted proxy, `req.ip` is the proxy: keying on it would put
      // every user of the internet in one bucket and deny them all together.
      expect(
        keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [request({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } })],
        ),
      ).toBe(1);
      expect(
        keysAfter(
          { RATE_LIMIT_LOGIN_IP: '10/15m' },
          [{ name: 'LOGIN_IP', scope: 'ip' }],
          [
            request({ headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }),
            request({ headers: { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' } }),
          ],
        ),
      ).toBe(2);
    });

    it('keys per-user routes by the authenticated id', () => {
      // This is the "per-user API limits" PROJECT.md section 14 asks for.
      expect(
        keysAfter(
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

    it('falls back to the IP when a user-scoped route has no session', () => {
      expect(
        keysAfter(
          { RATE_LIMIT_REFRESH_IP: '10/15m' },
          [{ name: 'REFRESH_IP', scope: 'user' }],
          [request({ ip: '5.5.5.5' }), request({ ip: '6.6.6.6' })],
        ),
      ).toBe(2);
    });

    it('normalises the submitted email so casing and padding cannot evade it', () => {
      // Without normalisation an attacker could reset the counter with
      // `victim@x.com`, `Victim@X.com` and ` victim@x.com `, and a limit that
      // can be evaded that easily is not a limit.
      expect(
        keysAfter(
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

    it('keeps distinct emails on distinct counters', () => {
      expect(
        keysAfter(
          { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
          [{ name: 'LOGIN_ACCOUNT', scope: 'email' }],
          [
            request({ body: { email: 'a@example.com' } }),
            request({ body: { email: 'b@example.com' } }),
          ],
        ),
      ).toBe(2);
    });

    it('falls back to the IP when the body carries no email', () => {
      // Bounds the key space: garbage bodies must not mint unbounded keys.
      const requests = [
        request({ body: {} }),
        request({ body: { email: '' } }),
        request({ body: { email: 42 } }),
        request({ body: null }),
        request({ body: 'not-an-object' }),
      ];

      expect(
        keysAfter(
          { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
          [{ name: 'LOGIN_ACCOUNT', scope: 'email' }],
          requests,
        ),
      ).toBe(1);
    });

    it('caps the email key length', () => {
      const long = `${'a'.repeat(1_000)}@example.com`;
      const store = new InMemoryRateLimitStore();
      const { guard, context } = harness({
        env: { RATE_LIMIT_LOGIN_ACCOUNT: '10/1h' },
        store,
        metadata: [{ name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' }],
        request: request({ body: { email: long } }),
      });

      guard.canActivate(context);

      expect(store.size()).toBe(1);
    });
  });

  describe('multiple rules on one route', () => {
    it('counts each rule separately and reports the one that rejected', () => {
      // Login carries an IP limit and an account limit; the 429 must name which.
      const store = new InMemoryRateLimitStore();
      const rules = [
        { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const },
        { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' as const },
      ];
      const body = { email: 'a@example.com' };
      const run = (): void => {
        harness({
          env: { RATE_LIMIT_LOGIN_IP: '100/15m', RATE_LIMIT_LOGIN_ACCOUNT: '1/1h' },
          store,
          metadata: rules,
          request: request({ body }),
        }).guard.canActivate(contextFor(request({ body }), responseDouble()));
      };

      run();

      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }

      expect((thrown as RateLimitedError).rule).toBe('LOGIN_ACCOUNT');
    });

    it('stops at the first rule that rejects, so later rules are not charged', () => {
      // Charging a rule whose request was already refused would let a caller
      // exhaust the per-account allowance with IP-blocked requests.
      const store = new InMemoryRateLimitStore();
      const rules = [
        { name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' as const },
        { name: RATE_LIMIT_RULES.LOGIN_ACCOUNT, scope: 'email' as const },
      ];
      const body = { email: 'a@example.com' };
      const run = (): void => {
        harness({
          env: { RATE_LIMIT_LOGIN_IP: '1/15m', RATE_LIMIT_LOGIN_ACCOUNT: '100/1h' },
          store,
          metadata: rules,
          request: request({ body }),
        }).guard.canActivate(contextFor(request({ body }), responseDouble()));
      };

      // First request is within both limits: the IP slot and the account slot are
      // both spent by exactly one call each.
      run();

      // Every request after that is blocked by the IP rule. The account rule
      // must never be reached, or a caller who is already IP-blocked could
      // still exhaust the per-account allowance using requests that were
      // refused.
      for (let i = 0; i < 5; i += 1) {
        expect(run).toThrow(RateLimitedError);
      }

      // Read the account counter directly: it must still show a single hit.
      const accountKey = 'LOGIN_ACCOUNT:a@example.com';
      const afterRejections = store.hit(
        accountKey,
        { limit: 100, windowMs: 3_600_000 },
        Date.now(),
      );

      expect(afterRejections.remaining).toBe(98);
    });
  });

  describe('headers', () => {
    it('writes limit, remaining and reset on an allowed request', () => {
      const store = new InMemoryRateLimitStore();
      const { guard, context, response } = harness({
        env: { RATE_LIMIT_LOGIN_IP: '10/15m' },
        store,
        metadata: [{ name: RATE_LIMIT_RULES.LOGIN_IP, scope: 'ip' }],
        request: request(),
      });

      guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '10');
      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '9');
      expect(response.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
      expect(response.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    });

    it('adds Retry-After when rejecting', () => {
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
      setup().guard.canActivate(contextFor(request(), responseDouble()));

      const { guard, context, response } = setup();
      expect(() => guard.canActivate(context)).toThrow(RateLimitedError);

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

    it('RateLimitByIp records the rule and scope', () => {
      expect(metadataFor(RateLimitByIp(RATE_LIMIT_RULES.REGISTER_IP))).toEqual([
        { name: 'REGISTER_IP', scope: 'ip' },
      ]);
    });

    it('RateLimitByUser records the user scope', () => {
      expect(metadataFor(RateLimitByUser(RATE_LIMIT_RULES.REFRESH_IP))).toEqual([
        { name: 'REFRESH_IP', scope: 'user' },
      ]);
    });

    it('RateLimit accepts several rules', () => {
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

  it('compares the fraction of budget left, not the raw count', () => {
    // Login runs an IP rule and an account rule with very different budgets.
    // Reporting "30 remaining" from the generous one while 1 of 2 is left on the
    // tight one would tell the client it has room when it does not.
    expect(tightestDecision([decision(2, 1), decision(30, 29)]).limit).toBe(2);
    expect(tightestDecision([decision(30, 29), decision(2, 1)]).limit).toBe(2);
  });

  it('ignores disabled rules', () => {
    expect(tightestDecision([decision(0, 0), decision(5, 4)]).limit).toBe(5);
    expect(tightestDecision([decision(5, 4), decision(0, 0)]).limit).toBe(5);
  });

  it('keeps the first when two are equally tight', () => {
    expect(tightestDecision([decision(10, 5), decision(20, 10)]).limit).toBe(10);
  });
});

describe('setRateLimitHeaders', () => {
  it('writes the three standard headers', () => {
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

  it('omits Retry-After for an allowed request', () => {
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

  it('never reports a negative reset time', () => {
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
  it('is a symbol, so it cannot collide with a class token', () => {
    expect(typeof RATE_LIMIT_STORE).toBe('symbol');
  });
});
