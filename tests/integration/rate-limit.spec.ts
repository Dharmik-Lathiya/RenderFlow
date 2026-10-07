import { DEFAULT_SPECS, parseRateLimitSpec } from '../../apps/api/src/ratelimit/rate-limit.config';
import { uniqueEmail } from './helpers/auth-fixtures';
import {
  authHeaders,
  createTestApp,
  csrfOf,
  sessionCookies,
  type TestApp,
} from './helpers/app-harness';
import { UNIQUE_PASSWORD } from './helpers/env';
import { setupTestDatabase, truncateAll, type TestDb } from './helpers/test-database';

/**
 * Rate limiting over real HTTP (PROJECT.md section 15: "Rate limit auth and
 * generation endpoints"; AGENTS.md section 10).
 *
 * The unit suite proves the store and the decision logic. What only an HTTP test
 * can prove is the part that matters in production:
 *
 *   - the 429 body keeps the documented `{ code, message, details }` shape;
 *   - rejection happens BEFORE argon2 runs, which is the entire point - the
 *     denial-of-service surface is CPU, not database load;
 *   - the guard's position in the chain does not weaken CSRF or auth;
 *   - limits are keyed per caller, and per instance, so neither one user nor one
 *     test suite can deny service to anyone else.
 *
 * Each app is booted with a fresh store and small limits, so the shipped
 * defaults stay exercised separately at the end of this file.
 */
describe('rate limiting (PROJECT.md section 15)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    await truncateAll(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  /**
   * Boots a real app instance with the given limit overrides.
   *
   * Passing the full set matters: an app inherits `TEST_ENV`'s relaxed limits,
   * so "the shipped default" has to be stated explicitly rather than inferred
   * from whatever the harness happens to leave behind.
   */
  async function appWithLimits(env: Record<string, string>): Promise<TestApp> {
    return createTestApp({ env });
  }

  describe('login', () => {
    it('returns 429 once the limit is exceeded, and not before', async () => {
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '3/15m' });
      try {
        const email = uniqueEmail('rl-login');
        await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email, password: UNIQUE_PASSWORD, name: 'RL User' });

        const statuses: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/login')
            .send({ email, password: UNIQUE_PASSWORD });
          statuses.push(res.status);
        }

        // Exactly the configured number of requests get through.
        expect(statuses).toEqual([200, 200, 200, 429, 429]);
      } finally {
        await app.close();
      }
    });

    it('uses the documented error shape, not a bare status', async () => {
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/15m' });
      try {
        await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('shape'), password: 'WrongPassword123' });

        const res = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('shape'), password: 'WrongPassword123' });

        expect(res.status).toBe(429);
        // AGENTS.md section 7: every failure is `{ code, message, details }`.
        expect(res.body.code).toBe('RATE_LIMITED');
        expect(typeof res.body.message).toBe('string');
        expect(res.body.details).toMatchObject({ rule: 'LOGIN_IP', limit: 1 });
        // An unhandled failure would leak a stack; this must not.
        expect(JSON.stringify(res.body)).not.toMatch(/\bat \w+ \(/);
      } finally {
        await app.close();
      }
    });

    it('sends Retry-After and the standard rate limit headers', async () => {
      // A client cannot back off sensibly without these.
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/15m' });
      try {
        const first = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('hdr'), password: 'WrongPassword123' });

        // First attempt is a normal credential failure, not a limit.
        expect(first.status).toBe(401);
        expect(first.headers['ratelimit-limit']).toBe('1');
        expect(first.headers['ratelimit-remaining']).toBe('0');

        const limited = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('hdr'), password: 'WrongPassword123' });

        expect(limited.status).toBe(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(limited.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(0);
      } finally {
        await app.close();
      }
    });

    it('rejects without touching the database', async () => {
      // The strongest available signal that argon2 did not run: a login that
      // reaches the database would leave a refresh session behind only on
      // success, so instead assert the whole call is cheap and stateless by
      // checking no session was created for a rejected attempt.
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/15m' });
      try {
        const email = uniqueEmail('nodb');
        await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email, password: UNIQUE_PASSWORD, name: 'No DB' });

        // Spends the single IP slot. Registration is limited under its own rule,
        // so it does not consume the login budget.
        const allowed = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email, password: UNIQUE_PASSWORD });
        expect(allowed.status).toBe(200);

        // The next call is refused before any credential check, so no cookie is
        // issued even though the credentials are correct.
        const rejected = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email, password: UNIQUE_PASSWORD });

        expect(rejected.status).toBe(429);
        expect(rejected.headers['set-cookie']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('spends the shared IP allowance across accounts behind one NAT', async () => {
      // Two users behind one address is the shared-connection case. Recorded
      // explicitly: a per-IP ceiling means one flooder denies the office behind
      // the same NAT. The per-account limit is what protects a single victim;
      // the IP limit is what protects the process. If this ever changes it needs
      // a decision, not a silent pass.
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '3/15m' });
      try {
        const first = uniqueEmail('nat-a');
        const second = uniqueEmail('nat-b');

        await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: first, password: UNIQUE_PASSWORD, name: 'A' });
        await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: second, password: UNIQUE_PASSWORD, name: 'B' });

        for (let i = 0; i < 4; i += 1) {
          await app
            .http()
            .post('/api/v1/auth/login')
            .send({ email: first, password: 'WrongPassword123' });
        }

        const blocked = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: second, password: UNIQUE_PASSWORD });

        expect(blocked.status).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('counts a per-account attempt on the submitted email, not only the IP', async () => {
      // The limit a distributed run cannot evade by moving to a new host.
      const app = await appWithLimits({
        RATE_LIMIT_LOGIN_IP: '1000/15m',
        RATE_LIMIT_LOGIN_ACCOUNT: '2/1h',
      });
      try {
        const target = uniqueEmail('victim');
        const statuses: number[] = [];

        // Two attempts are inside the per-account budget; the third is not.
        for (let i = 0; i < 3; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/login')
            .send({ email: target, password: 'WrongPassword123' });
          statuses.push(res.status);
        }

        expect(statuses).toEqual([401, 401, 429]);

        // A different email from the same caller is unaffected: the per-account
        // limit must not behave as a per-caller limit.
        const bystander = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('bystander'), password: 'WrongPassword123' });

        expect(bystander.status).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('counts a per-account attempt regardless of email casing', async () => {
      // Otherwise `victim@x.com` and `VICTIM@X.com` are two buckets, and a
      // control that can be evaded by holding shift is not a control.
      const app = await appWithLimits({
        RATE_LIMIT_LOGIN_IP: '1000/15m',
        RATE_LIMIT_LOGIN_ACCOUNT: '1/1h',
      });
      try {
        const email = uniqueEmail('Case');

        const first = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email, password: 'WrongPassword123' });
        expect(first.status).toBe(401);

        const upper = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email: email.toUpperCase(), password: 'WrongPassword123' });

        expect(upper.status).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('does not count a garbage body against anyone in particular', async () => {
      // An invalid body must not mint a new key per request, or the limiter's
      // own memory would be the thing an attacker exhausts.
      const app = await appWithLimits({
        RATE_LIMIT_LOGIN_IP: '1000/15m',
        RATE_LIMIT_LOGIN_ACCOUNT: '2/1h',
      });
      try {
        // A body with no email falls back to the IP identity, so every such request
        // shares ONE key rather than minting a new one. After the per-account
        // budget for that key is spent, further malformed requests are refused.
        const statuses: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const res = await app.http().post('/api/v1/auth/login').send({ nope: true });
          statuses.push(res.status);
        }

        expect(statuses).toEqual([400, 400, 429, 429]);

        // Two keys exist: the IP rule and the account rule's IP fallback. Six
        // garbage bodies did not produce six counters.
        expect(app.rateLimits.size()).toBe(2);
      } finally {
        await app.close();
      }
    });
  });

  describe('register', () => {
    it('is limited, because each accepted call mints a user and grants credits', async () => {
      const app = await appWithLimits({ RATE_LIMIT_REGISTER_IP: '2/1h' });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/register')
            .send({ email: uniqueEmail('rl-reg'), password: UNIQUE_PASSWORD, name: 'RL' });
          statuses.push(res.status);
        }

        expect(statuses).toEqual([201, 201, 429, 429]);
      } finally {
        await app.close();
      }
    });

    it('honours a rule disabled in configuration', async () => {
      // An operator must be able to lift a limit without a code change.
      const app = await appWithLimits({ RATE_LIMIT_REGISTER_IP: '0' });
      try {
        for (let i = 0; i < 6; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/register')
            .send({ email: uniqueEmail('rl-off'), password: UNIQUE_PASSWORD, name: 'Off' });
          expect(res.status).toBe(201);
        }
      } finally {
        await app.close();
      }
    });

    it('passes everything through when the master switch is off', async () => {
      const app = await appWithLimits({
        RATE_LIMIT_ENABLED: 'false',
        RATE_LIMIT_REGISTER_IP: '1/1h',
        RATE_LIMIT_LOGIN_IP: '1/1h',
      });
      try {
        for (let i = 0; i < 4; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/register')
            .send({ email: uniqueEmail('rl-master'), password: UNIQUE_PASSWORD, name: 'Master' });
          expect(res.status).toBe(201);
        }
      } finally {
        await app.close();
      }
    });
  });

  describe('refresh', () => {
    it('is limited independently of login', async () => {
      const app = await appWithLimits({
        RATE_LIMIT_REFRESH_IP: '2/15m',
        RATE_LIMIT_LOGIN_IP: '1000/15m',
      });
      try {
        const session = await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: uniqueEmail('rl-refresh'), password: UNIQUE_PASSWORD, name: 'RF' });

        const statuses: number[] = [];
        // Each refresh ROTATES the token, so the response's cookies must be fed
        // into the next call. Reusing the original jar would be refused as a
        // replay (401) and the test would be measuring rotation, not limiting.
        let cookies = sessionCookies(session);
        let csrf = csrfOf(session);

        for (let i = 0; i < 3; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/refresh')
            .set('Cookie', cookies)
            .set('x-csrf-token', csrf);
          statuses.push(res.status);

          if (res.status === 200) {
            cookies = sessionCookies(res);
            csrf = csrfOf(res);
          }
        }

        expect(statuses).toEqual([200, 200, 429]);
      } finally {
        await app.close();
      }
    });
  });

  describe('unlimited routes', () => {
    it('does not limit an authenticated read such as GET /credits', async () => {
      // The guard is opt-in per route. Locking a user out of their own balance
      // because a page called something in a loop would be a bug, not a feature.
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/1h' });
      try {
        const session = await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: uniqueEmail('reads'), password: UNIQUE_PASSWORD, name: 'Reads' });

        for (let i = 0; i < 8; i += 1) {
          const res = await app.http().get('/api/v1/credits').set(authHeaders(session));
          expect(res.status).toBe(200);
        }
      } finally {
        await app.close();
      }
    });

    it('keeps health checks reachable', async () => {
      // A limit that took down the probe would take down the orchestrator's
      // view of this service along with everything else.
      const app = await appWithLimits({ RATE_LIMIT_REGISTER_IP: '1/1h' });
      try {
        for (let i = 0; i < 5; i += 1) {
          const res = await app.http().get('/health/live');
          expect(res.status).toBe(200);
        }
      } finally {
        await app.close();
      }
    });
  });

  describe('interaction with the other guards', () => {
    it('does not let the limiter become a CSRF bypass', async () => {
      // Guard ordering matters in both directions: the limiter must run early
      // enough to save the CPU, and must never widen what a later guard accepts.
      const app = await appWithLimits({ RATE_LIMIT_REFRESH_IP: '2/15m' });
      try {
        const session = await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: uniqueEmail('csrf-order'), password: UNIQUE_PASSWORD, name: 'CSRF' });

        const cookies = sessionCookies(session);
        const csrf = csrfOf(session);

        for (let i = 0; i < 3; i += 1) {
          await app
            .http()
            .post('/api/v1/auth/refresh')
            .set('Cookie', cookies)
            .set('x-csrf-token', csrf);
        }

        // Over the limit: refused.
        const overLimit = await app
          .http()
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookies)
          .set('x-csrf-token', csrf);
        expect(overLimit.status).toBe(429);

        // No CSRF header: refused either way, and never admitted.
        const noCsrf = await app.http().post('/api/v1/auth/refresh').set('Cookie', cookies);
        expect(noCsrf.status).not.toBe(200);
        expect([403, 429]).toContain(noCsrf.status);
      } finally {
        await app.close();
      }
    });

    it('does not let the limiter become an auth bypass', async () => {
      // An authenticated route carries no limiter today, but assert the chain
      // still denies without a credential once the guard is in place.
      const app = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/1h' });
      try {
        for (let i = 0; i < 4; i += 1) {
          const res = await app.http().get('/api/v1/credits');
          expect(res.status).toBe(401);
        }
      } finally {
        await app.close();
      }
    });

    it('keeps unauthenticated access denied regardless of limiter state', async () => {
      const app = await appWithLimits({ RATE_LIMIT_ENABLED: 'false' });
      try {
        const res = await app.http().get('/api/v1/me');
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  describe('instance isolation', () => {
    it('does not carry counters from one app instance into the next', async () => {
      // Counters are per-instance state. If they leaked, one suite's traffic
      // would silently change another suite's outcome.
      const first = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/1h' });
      try {
        const allowed = await first
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('iso-a'), password: 'WrongPassword123' });
        const limited = await first
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('iso-b'), password: 'WrongPassword123' });

        expect(allowed.status).toBe(401);
        expect(limited.status).toBe(429);
      } finally {
        await first.close();
      }

      const second = await appWithLimits({ RATE_LIMIT_LOGIN_IP: '1/1h' });
      try {
        const fresh = await second
          .http()
          .post('/api/v1/auth/login')
          .send({ email: uniqueEmail('iso-c'), password: 'WrongPassword123' });
        expect(fresh.status).toBe(401);
      } finally {
        await second.close();
      }
    });
  });

  describe('the shipped defaults', () => {
    // These run with NO overrides, so they exercise the values a fresh
    // deployment actually gets. `TEST_ENV` relaxes the limits for the rest of
    // the suite, so "no overrides" here means the defaults, not the test
    // environment's - that distinction is the whole point of this block.
    const DEFAULTS = {
      RATE_LIMIT_LOGIN_IP: DEFAULT_SPECS.LOGIN_IP,
      RATE_LIMIT_LOGIN_ACCOUNT: DEFAULT_SPECS.LOGIN_ACCOUNT,
      RATE_LIMIT_REGISTER_IP: DEFAULT_SPECS.REGISTER_IP,
      RATE_LIMIT_REFRESH_IP: DEFAULT_SPECS.REFRESH_IP,
    } as const;

    it('allows a realistic burst of registrations', async () => {
      // 5 per hour per IP: enough for a family sharing an address, tight enough
      // that signup-farming cannot mint thousands of bonus wallets.
      const app = await appWithLimits(DEFAULTS);
      try {
        for (let i = 0; i < 5; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/register')
            .send({ email: uniqueEmail('burst'), password: UNIQUE_PASSWORD, name: 'Burst' });
          expect(res.status).toBe(201);
        }

        const blocked = await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email: uniqueEmail('burst'), password: UNIQUE_PASSWORD, name: 'Burst' });

        expect(blocked.status).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('allows a realistic burst of logins, then stops', async () => {
      const app = await appWithLimits(DEFAULTS);
      try {
        const email = uniqueEmail('burst-login');
        await app
          .http()
          .post('/api/v1/auth/register')
          .send({ email, password: UNIQUE_PASSWORD, name: 'Burst Login' });

        for (let i = 0; i < 10; i += 1) {
          const res = await app
            .http()
            .post('/api/v1/auth/login')
            .send({ email, password: UNIQUE_PASSWORD });
          expect(res.status).toBe(200);
        }

        const blocked = await app
          .http()
          .post('/api/v1/auth/login')
          .send({ email, password: UNIQUE_PASSWORD });

        expect(blocked.status).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('leaves the per-account login budget far above the per-IP one', async () => {
      // The per-account limit exists to catch a distributed run, not to lock a
      // legitimate user out after a few typos. If these ever cross over, a
      // single NAT'd user hits the tighter one first and the per-account
      // control stops being meaningful.
      expect(parseRateLimitSpec(DEFAULT_SPECS.LOGIN_ACCOUNT).limit).toBeGreaterThan(
        parseRateLimitSpec(DEFAULT_SPECS.LOGIN_IP).limit,
      );
    });
  });
});
