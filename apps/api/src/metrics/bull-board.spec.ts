import type { NextFunction, Request, Response } from 'express';

import { signAccessToken } from '../auth/token.service';
import type { AuthConfig } from '../auth/auth.config';
import { adminOnly } from './bull-board';

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
function fakeRequest(input: { authorization?: string; cookies?: Record<string, string> }): Request {
  return {
    headers: input.authorization === undefined ? {} : { authorization: input.authorization },
    cookies: input.cookies,
  } as unknown as Request;
}

function run(request: Request) {
  const response = fakeResponse();
  const next = jest.fn<NextFunction, []>();
  adminOnly(authConfig)(request, response as unknown as Response, next);
  return { response, next };
}

describe('adminOnly', () => {
  it('refuses a request with no token', () => {
    const { response, next } = run(fakeRequest({}));

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a token signed with another secret', () => {
    const forged = signAccessToken({
      userId: 'u1',
      role: 'ADMIN',
      secret: 'not-the-right-secret-not-the-right-secret',
      ttlSeconds: 900,
    }).token;

    const { response, next } = run(fakeRequest({ authorization: `Bearer ${forged}` }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an expired token', () => {
    const old = tokenFor('ADMIN', Date.now() - 3_600_000, 60);
    const { response, next } = run(fakeRequest({ authorization: `Bearer ${old}` }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user who is not a global admin', () => {
    // A workspace OWNER is not an operator of the queue board: the board shows
    // every tenant's payloads.
    const { response, next } = run(fakeRequest({ authorization: `Bearer ${tokenFor('MEMBER')}` }));

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
  });

  it('admits an admin from the Authorization header', () => {
    const { response, next } = run(fakeRequest({ authorization: `Bearer ${tokenFor('ADMIN')}` }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(0);
  });

  it('admits an admin from the session cookie', () => {
    // The browser board is opened by navigation, not by a fetch with a header.
    const { next } = run(fakeRequest({ cookies: { rf_access: tokenFor('ADMIN') } }));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not treat an empty cookie as a token', () => {
    const { response, next } = run(fakeRequest({ cookies: { rf_access: '' } }));

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
