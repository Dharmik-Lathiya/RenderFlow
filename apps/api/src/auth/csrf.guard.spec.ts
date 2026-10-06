import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { AppError } from '@renderflow/common';

import { CSRF_COOKIE, CSRF_HEADER } from './auth.config';
import { CsrfGuard } from './csrf.guard';
import type { RequestWithAuth } from './request.types';

function contextFor(request: Partial<RequestWithAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request as RequestWithAuth,
      getResponse: () => undefined,
    }),
    getHandler: () => () => undefined,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

function guard(exempt: readonly string[] = ['/auth/login', '/auth/register']): CsrfGuard {
  return new CsrfGuard({ exemptPaths: exempt }, new ConfigService({}));
}

function post(path: string, cookies: Record<string, string>, headers: Record<string, string> = {}) {
  return contextFor({ method: 'POST', path, cookies, headers });
}

describe('CsrfGuard', () => {
  it('allows safe methods without a token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard().canActivate(contextFor({ method, path: '/api/v1/me', headers: {} }))).toBe(
        true,
      );
    }
  });

  it('allows a matching cookie + header pair', () => {
    expect(
      guard().canActivate(
        post(
          '/api/v1/auth/logout',
          { [CSRF_COOKIE]: 'token-value' },
          { [CSRF_HEADER]: 'token-value' },
        ),
      ),
    ).toBe(true);
  });

  it('rejects a mismatched header', () => {
    // The scenario this guard exists for: a cross-site request that can send the
    // cookie but cannot set the header to match it.
    expect(() =>
      guard().canActivate(
        post('/api/v1/auth/logout', { [CSRF_COOKIE]: 'cookie-value' }, { [CSRF_HEADER]: 'other' }),
      ),
    ).toThrow(AppError);
  });

  it('rejects a missing header', () => {
    expect(() =>
      guard().canActivate(post('/api/v1/auth/logout', { [CSRF_COOKIE]: 'token' })),
    ).toThrow(/Missing CSRF header/);
  });

  it('rejects a missing cookie', () => {
    expect(() =>
      guard().canActivate(post('/api/v1/auth/logout', {}, { [CSRF_HEADER]: 'token' })),
    ).toThrow(/Missing CSRF cookie/);
  });

  it('rejects a request with neither', () => {
    expect(() => guard().canActivate(post('/api/v1/auth/logout', {}))).toThrow(AppError);
  });

  it('exempts the unauthenticated entry points', () => {
    for (const path of ['/auth/login', '/auth/register']) {
      expect(guard().canActivate(post(path, {}))).toBe(true);
    }
  });

  it('still exempts them once the /api/v1 prefix is mounted', () => {
    // Guards run before routing, so request.path is the prefixed URL. An
    // exemption list written for unprefixed paths must keep working.
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/register']) {
      expect(guard().canActivate(post(path, {}))).toBe(true);
    }
  });

  it('does not over-exempt a lookalike path under the prefix', () => {
    expect(() => guard().canActivate(post('/api/v1/auth/login-extra', {}))).toThrow(AppError);
  });

  it('does NOT exempt refresh, which is state-changing', () => {
    expect(() => guard().canActivate(post('/api/v1/auth/refresh', {}))).toThrow(AppError);
  });

  it('reads additional exempt paths from configuration', () => {
    const configured = new CsrfGuard(
      { exemptPaths: [] },
      new ConfigService({ CSRF_EXEMPT_PATHS: '/webhook/stripe' }),
    );

    expect(configured.canActivate(post('/webhook/stripe', {}))).toBe(true);
    expect(() => configured.canActivate(post('/api/v1/posts', {}))).toThrow(AppError);
  });

  it('accepts an array header value', () => {
    expect(
      guard().canActivate(
        post(
          '/api/v1/auth/logout',
          { [CSRF_COOKIE]: 'v' },
          { [CSRF_HEADER]: ['v', 'other'] as unknown as string },
        ),
      ),
    ).toBe(true);
  });
});
