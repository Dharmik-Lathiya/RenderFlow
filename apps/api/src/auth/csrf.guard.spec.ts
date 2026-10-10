import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { AppError } from '@renderflow/common';

import { ACCESS_TOKEN_COOKIE, CSRF_COOKIE, CSRF_HEADER } from './auth.config';
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

/**
 * Builds a cookie-authenticated POST.
 *
 * The session cookie is always included, because that is the request CSRF
 * actually defends against: a browser attaching ambient credentials to a
 * cross-site request. A POST with no session cookie has nothing to forge, so the
 * guard lets it through to AuthGuard, which is where it belongs.
 */
function post(
  path: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return contextFor({
    method: 'POST',
    path,
    cookies: { [ACCESS_TOKEN_COOKIE]: 'session-token', ...cookies },
    headers,
  });
}

/** A POST with no session cookie at all - not a CSRF-relevant request. */
function anonymousPost(path: string, headers: Record<string, string> = {}) {
  return contextFor({ method: 'POST', path, cookies: {}, headers });
}

describe('CsrfGuard', () => {
  it('lets a request with no session cookie through to AuthGuard', () => {
    // CSRF defends ambient credentials. A POST carrying no session cookie has
    // nothing for a cross-site page to ride on, so refusing it here would report
    // a CSRF failure for what is actually a missing-credentials problem - and the
    // caller would see 403 CSRF_TOKEN_INVALID instead of 401 UNAUTHORIZED.
    expect(guard().canActivate(anonymousPost('/api/v1/brands'))).toBe(true);
    expect(guard().canActivate(anonymousPost('/api/v1/auth/logout'))).toBe(true);
  });

  it('exempts bearer-authenticated requests', () => {
    // A cross-site request cannot set an Authorization header, so a bearer client
    // (mobile, CLI) is not forgeable and must not be asked for a CSRF token.
    const bearer = contextFor({
      method: 'POST',
      path: '/api/v1/brands',
      cookies: {},
      headers: { authorization: 'Bearer some-access-token' },
    });

    expect(guard().canActivate(bearer)).toBe(true);
  });

  it('gives the bearer header precedence, matching AuthGuard', () => {
    // AuthGuard prefers an Authorization header over a cookie when both are
    // present. A request that authenticates by header is not forgeable, so CSRF
    // does not apply - and having the two guards disagree about which credential
    // counts would be far more confusing than either rule alone.
    const both = contextFor({
      method: 'POST',
      path: '/api/v1/brands',
      cookies: { [ACCESS_TOKEN_COOKIE]: 'session-token', [CSRF_COOKIE]: 'cookie-value' },
      headers: { authorization: 'Bearer some-access-token', [CSRF_HEADER]: 'other' },
    });

    expect(guard().canActivate(both)).toBe(true);
  });

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
    expect(() => guard().canActivate(post('/api/v1/auth/logout'))).toThrow(AppError);
  });

  it('exempts the unauthenticated entry points', () => {
    for (const path of ['/auth/login', '/auth/register']) {
      expect(guard().canActivate(post(path))).toBe(true);
    }
  });

  it('still exempts them once the /api/v1 prefix is mounted', () => {
    // Guards run before routing, so request.path is the prefixed URL. An
    // exemption list written for unprefixed paths must keep working.
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/register']) {
      expect(guard().canActivate(post(path))).toBe(true);
    }
  });

  it('does not over-exempt a lookalike path under the prefix', () => {
    expect(() => guard().canActivate(post('/api/v1/auth/login-extra'))).toThrow(AppError);
  });

  it('does NOT exempt refresh, which is state-changing', () => {
    expect(() => guard().canActivate(post('/api/v1/auth/refresh'))).toThrow(AppError);
  });

  it('reads additional exempt paths from configuration', () => {
    const configured = new CsrfGuard(
      { exemptPaths: [] },
      new ConfigService({ CSRF_EXEMPT_PATHS: '/webhook/stripe' }),
    );

    expect(configured.canActivate(post('/webhook/stripe'))).toBe(true);
    expect(() => configured.canActivate(post('/api/v1/posts'))).toThrow(AppError);
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
