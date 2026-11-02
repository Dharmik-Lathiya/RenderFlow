import type { NextFunction, Request, Response } from 'express';

import { signAccessToken } from '../auth/token.service';
import type { AuthConfig } from '../auth/auth.config';
import { adminOnly, type BullBoardAudit } from './bull-board';

/**
 * The Bull Board guard.
 *
 * Bull Board's router is mounted with `app.use`, so Nest's global AuthGuard does
 * not run for it. That makes this function the only thing between an
 * unauthenticated request and every workspace's job payloads, and it is why the
 * test is about refusal rather than about the happy path.
 */

const SECRET = 'test-access-secret-that-is-definitely-long-enough';
const authConfig = { JWT_ACCESS_SECRET: SECRET } as AuthConfig;

function tokenFor(role: string, now?: number, ttlSeconds = 900): string {
  return signAccessToken({ userId: 'u1', role, secret: SECRET, ttlSeconds, now }).token;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

/**
 * A minimal express request. The cast is confined to this helper because express
 * Request has dozens of members this middleware never touches.
 */
function fakeRequest(input: {
  authorization?: string;
  cookies?: Record<string, string>;
  method?: string;
  path?: string;
  ip?: string;
}): Request {
  return {
    headers: input.authorization === undefined ? {} : { authorization: input.authorization },
    cookies: input.cookies,
    method: input.method ?? 'GET',
    path: input.path ?? '/',
    ip: input.ip,
  } as unknown as Request;
}

async function run(request: Request, audit?: BullBoardAudit) {
  const response = fakeResponse();
  const next = jest.fn<NextFunction, []>();
  await adminOnly(authConfig, audit)(request, response as unknown as Response, next);
  return { response, next };
}

describe('adminOnly', () => {
  it('refuses a request with no token', async () => {
    const { response, next } = await run(fakeRequest({}));

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a token signed with another secret', async () => {
    const forged = signAccessToken({
      userId: 'u1',
      role: 'ADMIN',
      secret: 'not-the-right-secret-not-the-right-secret',
      ttlSeconds: 900,
    }).token;

    const { response, next } = await run(fakeRequest({ authorization: `Bearer ${forged}` }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an expired token', async () => {
    const old = tokenFor('ADMIN', Date.now() - 3_600_000, 60);
    const { response, next } = await run(fakeRequest({ authorization: `Bearer ${old}` }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user who is not a global admin', async () => {
    // A workspace OWNER is not an operator of the queue board: the board shows
    // every tenant's payloads.
    const { response, next } = await run(
      fakeRequest({ authorization: `Bearer ${tokenFor('MEMBER')}` }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
  });

  it('admits an admin from the Authorization header', async () => {
    const { response, next } = await run(
      fakeRequest({ authorization: `Bearer ${tokenFor('ADMIN')}` }),
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
  });

  it('admits an admin from the session cookie', async () => {
    // The browser board is opened by navigation, not by a fetch with a header.
    const { next } = await run(fakeRequest({ cookies: { rf_access: tokenFor('ADMIN') } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not treat an empty cookie as a token', async () => {
    const { response, next } = await run(fakeRequest({ cookies: { rf_access: '' } }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('records an operator visit before serving the board', async () => {
    const record = jest.fn(async () => undefined);
    const audit: BullBoardAudit = { record };

    const { next } = await run(
      fakeRequest({
        authorization: `Bearer ${tokenFor('ADMIN')}`,
        method: 'GET',
        path: '/api/queues',
        ip: '203.0.113.9',
      }),
      audit,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      actorId: 'u1',
      role: 'ADMIN',
      method: 'GET',
      path: '/api/queues',
      ip: '203.0.113.9',
    });
  });

  it('does not audit static assets', async () => {
    // One board page loads several of them; a row each would bury the visits.
    const record = jest.fn(async () => undefined);

    const { next } = await run(
      fakeRequest({
        authorization: `Bearer ${tokenFor('ADMIN')}`,
        path: '/static/js/main.js',
      }),
      { record },
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses the board when the access cannot be audited', async () => {
    // The board shows every tenant's job payloads. An access with no durable
    // record is the exact failure the audit exists to prevent.
    const record = jest.fn(async () => {
      throw new Error('database down');
    });

    const { response, next } = await run(
      fakeRequest({ authorization: `Bearer ${tokenFor('ADMIN')}` }),
      { record },
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('does not audit a request that fails authorization', async () => {
    const record = jest.fn(async () => undefined);

    await run(fakeRequest({ authorization: `Bearer ${tokenFor('MEMBER')}` }), { record });

    expect(record).not.toHaveBeenCalled();
  });
});
