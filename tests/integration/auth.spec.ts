import { and, count, eq, inArray, isNull } from 'drizzle-orm';

import { creditLedger, refreshSessions, users, workspaces } from '@renderflow/db';

import { TEST_PASSWORD, uniqueEmail, walletOf } from './helpers/auth-fixtures';
import {
  authHeaders,
  cookieFrom,
  createTestApp,
  csrfOf,
  sessionCookies,
  type TestApp,
} from './helpers/app-harness';
import { UNIQUE_PASSWORD } from './helpers/env';
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateAll,
  type TestDb,
} from './helpers/test-database';

/**
 * Phase 1 DoD (PROJECT.md section 12):
 *   - a new user ALWAYS has exactly 50 credits;
 *   - registering concurrently with the same email never grants twice.
 *
 * These go through HTTP so the guards, zod validation, cookies and the global
 * exception filter are all in the path. The database is real.
 */
describe('auth (Phase 1 DoD)', () => {
  let db: TestDb;
  let app: TestApp;

  beforeAll(async () => {
    db = await setupTestDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  /** Counts rows matching a filter, for readability in assertions. */
  const countUsers = (email: string): Promise<number> =>
    db
      .select({ value: count() })
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0]?.value ?? 0);

  const countBonus = (userId: string): Promise<number> =>
    db
      .select({ value: count() })
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, userId), eq(creditLedger.entryType, 'SIGNUP_BONUS')))
      .then((rows) => rows[0]?.value ?? 0);

  const countActiveSessions = (userId: string): Promise<number> =>
    db
      .select({ value: count() })
      .from(refreshSessions)
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)))
      .then((rows) => rows[0]?.value ?? 0);

  const userIdByEmail = async (email: string): Promise<string> => {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (rows[0] === undefined) {
      throw new Error(`no user for ${email}`);
    }
    return rows[0].id;
  };

  describe('POST /auth/register', () => {
    it('creates the user with exactly 50 credits and one bonus ledger row', async () => {
      const email = uniqueEmail('register');

      const res = await app.http().post('/api/v1/auth/register').send({
        email,
        password: UNIQUE_PASSWORD,
        name: 'Ada Founder',
      });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email, name: 'Ada Founder', role: 'MEMBER' });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.csrfToken).toEqual(expect.any(String));

      // C1: the DoD's headline promise.
      const userId = await userIdByEmail(email);
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
      await expect(countBonus(userId)).resolves.toBe(1);
    });

    it('never returns the password hash', async () => {
      const email = uniqueEmail('nohash');
      const res = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Hash Check' });

      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('$argon2');
    });

    it('sets httpOnly auth cookies and a readable CSRF cookie', async () => {
      const email = uniqueEmail('cookies');
      const res = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Cookie User' });

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('rf_access='));
      const refresh = cookies.find((c) => c.startsWith('rf_refresh='));
      const csrf = cookies.find((c) => c.startsWith('rf_csrf='));

      expect(access).toMatch(/HttpOnly/i);
      expect(access).toMatch(/SameSite=Lax/i);
      expect(refresh).toMatch(/HttpOnly/i);
      // The CSRF cookie must be readable by JS so the client can echo it.
      expect(csrf).toBeDefined();
      expect(csrf).not.toMatch(/HttpOnly/i);
    });

    it('gives the access cookie the configured lifetime, not 900 seconds', async () => {
      // Regression guard: Express wants maxAge in milliseconds. Passing seconds
      // produced Max-Age=900, which the browser read as 15 *seconds* and dropped
      // immediately, so every authenticated request 401'd.
      const res = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('maxage'), password: UNIQUE_PASSWORD, name: 'Max Age' });

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('rf_access=')) as string;

      // Express divides maxAge (ms) by 1000 before serialising, so a 15-minute
      // token must surface as Max-Age=900 *seconds*.
      expect(/Max-Age=900\b/.test(access)).toBe(true);

      const expires = new Date(/Expires=([^;]+)/.exec(access)?.[1] ?? '').getTime();
      const fifteenMinutesMs = 15 * 60 * 1000;
      expect(expires - Date.now()).toBeGreaterThan(fifteenMinutesMs * 0.9);
      expect(expires - Date.now()).toBeLessThan(fifteenMinutesMs * 1.1);
    });

    it('issues a cookie that survives the next request', async () => {
      // The user-visible consequence of the Max-Age bug: a 200 on register
      // followed by a 401 on the very next call.
      const email = uniqueEmail('persist');
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Persist' });

      expect(session.status).toBe(201);

      const me = await app.http().get('/api/v1/me').set(authHeaders(session));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email });
    });

    it('does not put the refresh token in the response body', async () => {
      const res = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('norefresh'), password: UNIQUE_PASSWORD, name: 'Refresh' });

      expect(res.body.refreshToken).toBeUndefined();
      expect(cookieFrom(res, 'rf_refresh')).toEqual(expect.any(String));
    });

    it('normalizes the email so case variants cannot create two accounts', async () => {
      // The API lowercases the whole address, so the expected stored form is the
      // lowercase version, not the mixed-case one the client sent.
      const email = uniqueEmail('CaseTest');
      const upper = email.toUpperCase();
      const normalized = email.toLowerCase();

      const first = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: upper, password: UNIQUE_PASSWORD, name: 'Case' });

      expect(first.status).toBe(201);
      expect(first.body.user.email).toBe(normalized);

      // Any other casing of the same address must collide.
      const second = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Case Again' });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('EMAIL_ALREADY_REGISTERED');
      await expect(countUsers(normalized)).resolves.toBe(1);
    });

    it('rejects a duplicate email with 409 and grants no second bonus', async () => {
      const email = uniqueEmail('dupe');

      const first = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'First' });
      expect(first.status).toBe(201);

      const second = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Second' });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('EMAIL_ALREADY_REGISTERED');

      const userId = await userIdByEmail(email);
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
      await expect(countBonus(userId)).resolves.toBe(1);
    });

    it('rejects a weak password before creating anything', async () => {
      const email = uniqueEmail('weak');

      const res = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: 'short', name: 'Weak' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      // Nothing at all was created: no user, so no wallet, so no bonus.
      await expect(countUsers(email)).resolves.toBe(0);
    });

    it('validates the body and reports field-level details', async () => {
      const res = await app.http().post('/api/v1/auth/register').send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.details)).toEqual(
        expect.arrayContaining(['email', 'password', 'name']),
      );
    });
  });

  describe('C2: concurrent registration of one email', () => {
    it('creates one user with one bonus when 15 registrations race', async () => {
      const email = uniqueEmail('concurrent');

      const attempts = await Promise.all(
        Array.from({ length: 15 }, () =>
          app
            .http()
            .post('/api/v1/auth/register')
            .send({ email, password: UNIQUE_PASSWORD, name: 'Racer' }),
        ),
      );

      const created = attempts.filter((r) => r.status === 201);
      const conflicts = attempts.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(14);
      // No request may fail in any other way (500 would mean a real bug).
      for (const attempt of attempts) {
        expect([201, 409]).toContain(attempt.status);
      }

      await expect(countUsers(email)).resolves.toBe(1);

      const userId = await userIdByEmail(email);
      // The invariant that matters: exactly one grant of 50 credits.
      await expect(walletOf(db, userId)).resolves.toEqual({ available: 50, reserved: 0 });
      await expect(countBonus(userId)).resolves.toBe(1);
    });

    it('gives every concurrent winner exactly the configured amount', async () => {
      const emails = Array.from({ length: 10 }, () => uniqueEmail('many'));

      await Promise.all(
        emails.map((email) =>
          app
            .http()
            .post('/api/v1/auth/register')
            .send({ email, password: UNIQUE_PASSWORD, name: 'Bulk' }),
        ),
      );

      const rows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.email, emails));
      expect(rows).toHaveLength(10);

      for (const row of rows) {
        await expect(walletOf(db, row.id)).resolves.toEqual({ available: 50, reserved: 0 });
      }

      const allBonus = await db
        .select({ value: count() })
        .from(creditLedger)
        .where(eq(creditLedger.entryType, 'SIGNUP_BONUS'));
      expect(allBonus[0]?.value).toBe(10);
    });
  });

  describe('POST /auth/login', () => {
    it('authenticates with correct credentials', async () => {
      const email = uniqueEmail('login');
      await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Login User' });

      const res = await app
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: UNIQUE_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(email);
      expect(cookieFrom(res, 'rf_access')).toEqual(expect.any(String));
      expect(cookieFrom(res, 'rf_refresh')).toEqual(expect.any(String));
    });

    it('rejects a wrong password without revealing whether the account exists', async () => {
      const email = uniqueEmail('wrongpw');
      await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Wrong PW' });

      const wrongPassword = await app
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPassword123' });
      const unknownEmail = await app
        .http()
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail('nobody'), password: 'WrongPassword123' });

      // Identical response: the endpoint must not enumerate registered emails.
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('does not change the credit balance', async () => {
      const email = uniqueEmail('nobalance');
      await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Balance' });

      await app.http().post('/api/v1/auth/login').send({ email, password: UNIQUE_PASSWORD });

      await expect(walletOf(db, await userIdByEmail(email))).resolves.toEqual({
        available: 50,
        reserved: 0,
      });
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token and returns a new access token', async () => {
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('refresh'), password: UNIQUE_PASSWORD, name: 'Refresh User' });

      const res = await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', sessionCookies(session))
        .set('x-csrf-token', csrfOf(session));

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));

      // Rotation means the old token must not be reusable.
      expect(cookieFrom(res, 'rf_refresh')).toBeDefined();
      expect(cookieFrom(res, 'rf_refresh')).not.toBe(cookieFrom(session, 'rf_refresh'));
    });

    it('rejects reuse of a rotated token', async () => {
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('reuse'), password: UNIQUE_PASSWORD, name: 'Reuse' });

      const staleRefresh = cookieFrom(session, 'rf_refresh') as string;
      const csrf = csrfOf(session);

      await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', sessionCookies(session))
        .set('x-csrf-token', csrf)
        .expect(200);

      // A stolen token is usable at most once: replay is refused.
      const replay = await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `rf_refresh=${staleRefresh}; rf_csrf=${csrf}`)
        .set('x-csrf-token', csrf);

      expect(replay.status).toBe(401);
    });

    it('requires CSRF on refresh because it changes state', async () => {
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail('csrfrefresh'),
          password: UNIQUE_PASSWORD,
          name: 'CSRF',
        });

      // Full cookie jar, but no x-csrf-token header: the header is the part a
      // cross-site request cannot forge.
      const res = await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', sessionCookies(session));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects an unknown refresh token', async () => {
      // A valid CSRF pair, so the failure is attributable to the refresh token
      // rather than to the CSRF guard, which runs first.
      const seed = await app
        .http()
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail('unknownrefresh'),
          password: UNIQUE_PASSWORD,
          name: 'Unknown',
        });
      const csrf = csrfOf(seed);

      const res = await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `rf_refresh=not-a-real-token; rf_csrf=${csrf}`)
        .set('x-csrf-token', csrf);

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session so the refresh token stops working', async () => {
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('logout'), password: UNIQUE_PASSWORD, name: 'Logout' });

      const refreshToken = cookieFrom(session, 'rf_refresh') as string;
      const csrf = csrfOf(session);

      await app
        .http()
        .post('/api/v1/auth/logout')
        .set('Cookie', `rf_refresh=${refreshToken}; rf_csrf=${csrf}`)
        .set('x-csrf-token', csrf)
        .expect(204);

      const after = await app
        .http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', `rf_refresh=${refreshToken}; rf_csrf=${csrf}`)
        .set('x-csrf-token', csrf);

      expect(after.status).toBe(401);
    });

    it('is idempotent', async () => {
      const session = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('logout2'), password: UNIQUE_PASSWORD, name: 'Logout 2' });

      const csrf = csrfOf(session);
      const refreshToken = cookieFrom(session, 'rf_refresh') as string;

      for (let i = 0; i < 2; i += 1) {
        await app
          .http()
          .post('/api/v1/auth/logout')
          .set('Cookie', `rf_refresh=${refreshToken}; rf_csrf=${csrf}`)
          .set('x-csrf-token', csrf)
          .expect(204);
      }
    });
  });

  describe('GET /me and GET /credits', () => {
    it('returns the profile for a cookie-authenticated session', async () => {
      const email = uniqueEmail('me');
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Profile User' });

      const res = await app.http().get('/api/v1/me').set(authHeaders(register));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email, name: 'Profile User', role: 'MEMBER' });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('accepts a bearer token, which is what a mobile client uses', async () => {
      const email = uniqueEmail('bearer');
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Mobile' });

      const res = await app
        .http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${register.body.accessToken as string}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email);
    });

    it('returns the balance and ledger from GET /credits', async () => {
      const email = uniqueEmail('credits');
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Credits User' });

      const res = await app.http().get('/api/v1/credits').set(authHeaders(register));

      expect(res.status).toBe(200);
      expect(res.body.wallet).toEqual({
        userId: expect.any(String),
        available: 50,
        reserved: 0,
        total: 50,
      });
      expect(res.body.ledger).toHaveLength(1);
      expect(res.body.ledger[0]).toMatchObject({ entryType: 'SIGNUP_BONUS', amount: 50 });
      expect(res.body.pagination.total).toBe(1);
    });

    it('clamps nonsense pagination instead of erroring', async () => {
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('page'), password: UNIQUE_PASSWORD, name: 'Page' });

      // A client sending page=0 or a huge pageSize must get a usable answer
      // rather than a 500 or an unbounded query.
      for (const query of ['?page=0', '?page=-5', '?pageSize=0', '?pageSize=99999']) {
        const res = await app.http().get(`/api/v1/credits${query}`).set(authHeaders(register));

        expect(res.status).toBe(200);
        expect(res.body.pagination.page).toBeGreaterThanOrEqual(1);
        expect(res.body.pagination.pageSize).toBeLessThanOrEqual(100);
      }
    });

    it('honours a valid page size', async () => {
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('pagesize'), password: UNIQUE_PASSWORD, name: 'Size' });

      const res = await app
        .http()
        .get('/api/v1/credits?page=1&pageSize=5')
        .set(authHeaders(register));

      expect(res.status).toBe(200);
      expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 5 });
    });

    it('rejects a non-numeric page rather than crashing', async () => {
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('badpage'), password: UNIQUE_PASSWORD, name: 'Bad' });

      const res = await app.http().get('/api/v1/credits?page=abc').set(authHeaders(register));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('returns 401 when the account behind a valid token is gone', async () => {
      // A token outliving its account must not resolve to a phantom user.
      const email = uniqueEmail('deleted');
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Deleted' });

      const headers = authHeaders(register);
      // Every user owns a personal workspace, and `workspaces.owner_id` is
      // ON DELETE RESTRICT so an owner can never be removed out from under a
      // workspace. Clear that first; the point of the test is the orphaned
      // access token, not the deletion order.
      await db.delete(workspaces).where(eq(workspaces.ownerId, await userIdByEmail(email)));
      await db.delete(users).where(eq(users.email, email));

      const res = await app.http().get('/api/v1/me').set(headers);
      expect(res.status).toBe(401);
    });

    it('revokes every session for a user', async () => {
      const email = uniqueEmail('multi');
      await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Multi' });

      // A second device: login issues its own refresh session.
      const second = await app
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: UNIQUE_PASSWORD });

      const userId = await userIdByEmail(email);
      await expect(countActiveSessions(userId)).resolves.toBe(2);

      const revoked = await app.auth.logoutAll(userId);
      expect(revoked).toBe(2);
      await expect(countActiveSessions(userId)).resolves.toBe(0);
      expect(cookieFrom(second, 'rf_refresh')).toBeDefined();
    });

    it('rejects unauthenticated access with 401', async () => {
      await expect(
        app
          .http()
          .get('/api/v1/me')
          .then((r) => r.status),
      ).resolves.toBe(401);
      await expect(
        app
          .http()
          .get('/api/v1/credits')
          .then((r) => r.status),
      ).resolves.toBe(401);
    });

    it('rejects a tampered access token', async () => {
      const register = await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('tamper'), password: UNIQUE_PASSWORD, name: 'Tamper' });

      const token = register.body.accessToken as string;
      const [header, payload] = token.split('.') as [string, string];
      const forged = `${header}.${payload}.forged-signature`;

      const res = await app.http().get('/api/v1/me').set('Cookie', `rf_access=${forged}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects an access token signed with the wrong secret', async () => {
      const res = await app
        .http()
        .get('/api/v1/me')
        .set('Cookie', 'rf_access=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bm90LWEtc2lnbmF0dXJl');

      expect(res.status).toBe(401);
    });

    it('keeps health endpoints reachable without auth', async () => {
      await expect(
        app
          .http()
          .get('/health/live')
          .then((r) => r.status),
      ).resolves.toBe(200);
    });
  });

  describe('password storage', () => {
    it('stores an argon2id hash, never the plaintext', async () => {
      const email = uniqueEmail('storage');
      await app
        .http()
        .post('/api/v1/auth/register')
        .send({ email, password: UNIQUE_PASSWORD, name: 'Storage' });

      const rows = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email));

      expect(rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(rows[0]?.passwordHash).not.toContain(UNIQUE_PASSWORD);
      expect(rows[0]?.passwordHash).not.toContain(TEST_PASSWORD);
    });
  });
});
