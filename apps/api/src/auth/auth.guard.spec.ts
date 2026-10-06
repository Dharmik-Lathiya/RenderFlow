import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@renderflow/common';

import type { Env } from '../config/env';
import { AuthGuard, RolesGuard, extractAccessToken, Public, Roles, ROLES_KEY } from './auth.guard';
import { signAccessToken } from './token.service';
import type { RequestWithAuth } from './request.types';

const SECRET = 's'.repeat(32);

type EnvConfig = ConfigService<Env, true>;

function configStub(): EnvConfig {
  // AuthGuard reads secrets from ConfigService by key. Every value in the
  // validated Env shape is required, so the stub fills the rest with defaults;
  // only the secrets matter to these tests.
  return new ConfigService<Env, true>({
    NODE_ENV: 'test',
    API_PORT: 4000,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://renderflow:renderflow@localhost:5432/renderflow_test',
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGINS: 'http://localhost:3000',
    WEB_BASE_URL: 'http://localhost:3000',
    JWT_ACCESS_SECRET: SECRET,
    JWT_REFRESH_SECRET: 'r'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '7d',
    TOKEN_ENCRYPTION_KEY: '',
    SIGNUP_BONUS_CREDITS: 50,
    CSRF_EXEMPT_PATHS: '',
    DB_LOG_LEVELS: 'warn,error',
    METRICS_ENABLED: false,
  });
}

function contextFor(
  request: Partial<RequestWithAuth>,
  handler = () => undefined,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request as RequestWithAuth,
      getResponse: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

function requestWith(overrides: Partial<RequestWithAuth> = {}): Partial<RequestWithAuth> {
  return { method: 'GET', headers: {}, cookies: {}, ...overrides };
}

describe('AuthGuard', () => {
  const guardFor = (reflector = new Reflector()) => new AuthGuard(reflector, configStub());

  it('lets a @Public() route through without a token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    expect(guardFor(reflector).canActivate(contextFor(requestWith()))).toBe(true);
  });

  it('denies a protected route with no token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

    expect(() => guardFor(reflector).canActivate(contextFor(requestWith()))).toThrow(AppError);
  });

  it('attaches the user from a cookie token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { token } = signAccessToken({
      userId: 'user-1',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });

    const request = requestWith({ cookies: { rf_access: token } });
    expect(guardFor(reflector).canActivate(contextFor(request))).toBe(true);
    expect(request.user).toEqual({ id: 'user-1', role: 'MEMBER' });
  });

  it('accepts a bearer token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { token } = signAccessToken({
      userId: 'user-2',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });

    const request = requestWith({ headers: { authorization: `Bearer ${token}` } });
    expect(guardFor(reflector).canActivate(contextFor(request))).toBe(true);
    expect(request.user?.id).toBe('user-2');
  });

  it('rejects an expired token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const now = 1_700_000_000_000;
    const { token } = signAccessToken({
      userId: 'u',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
      now,
    });

    const request = requestWith({ cookies: { rf_access: token } });
    jest.spyOn(Date, 'now').mockReturnValue(now + 901_000);

    expect(() => guardFor(reflector).canActivate(contextFor(request))).toThrow(/expired/i);
  });
});

describe('extractAccessToken', () => {
  it('prefers the Authorization header over a cookie', () => {
    // An explicit credential must never be silently overridden by a stale cookie.
    expect(
      extractAccessToken(
        requestWith({
          headers: { authorization: 'Bearer from-header' },
          cookies: { rf_access: 'from-cookie' },
        }) as RequestWithAuth,
      ),
    ).toBe('from-header');
  });

  it('falls back to the cookie', () => {
    expect(
      extractAccessToken(requestWith({ cookies: { rf_access: 'from-cookie' } }) as RequestWithAuth),
    ).toBe('from-cookie');
  });

  it('returns null when neither is present', () => {
    expect(extractAccessToken(requestWith() as RequestWithAuth)).toBeNull();
  });

  it('ignores an empty bearer value and falls back to the cookie', () => {
    expect(
      extractAccessToken(
        requestWith({
          headers: { authorization: 'Bearer   ' },
          cookies: { rf_access: 'from-cookie' },
        }) as RequestWithAuth,
      ),
    ).toBe('from-cookie');
  });

  it('ignores a non-Bearer authorization scheme', () => {
    expect(
      extractAccessToken(
        requestWith({ headers: { authorization: 'Basic abc' } }) as RequestWithAuth,
      ),
    ).toBeNull();
  });
});

describe('RolesGuard', () => {
  it('allows a route with no role requirement', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    expect(new RolesGuard(reflector).canActivate(contextFor(requestWith()))).toBe(true);
  });

  it('allows a user holding the required role', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);

    const request = requestWith({ user: { id: 'u1', role: 'ADMIN' } });
    expect(new RolesGuard(reflector).canActivate(contextFor(request))).toBe(true);
  });

  it('rejects a user without the role', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);

    const request = requestWith({ user: { id: 'u1', role: 'MEMBER' } });
    expect(() => new RolesGuard(reflector).canActivate(contextFor(request))).toThrow(AppError);
  });

  it('rejects an unauthenticated request', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);

    expect(() => new RolesGuard(reflector).canActivate(contextFor(requestWith()))).toThrow(
      /Authentication required/,
    );
  });
});

describe('route decorators', () => {
  it('sets metadata that Reflector can read back', () => {
    const handler = Roles('ADMIN');
    expect(typeof handler).toBe('function');
    expect(typeof Public()).toBe('function');
    expect(ROLES_KEY).toBe('renderflow:roles');
  });
});
