import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { timingSafeEqual } from './password';

import { CSRF_COOKIE, CSRF_HEADER } from './auth.config';
import type { RequestWithAuth } from './request.types';

/** Methods that cannot change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  /** Paths exempt from the check, e.g. `/auth/login` before a session exists. */
  exemptPaths: readonly string[];
}

/**
 * Injection token for `CsrfOptions`.
 *
 * A guard registered via `APP_GUARD` is instantiated by Nest, so any extra
 * constructor parameter must be a resolvable provider. `@Optional()` plus a
 * fallback would silently disable the guard, so the options are required and
 * supplied explicitly in app.module.
 */
export const CSRF_OPTIONS = Symbol('CSRF_OPTIONS');

/**
 * Double-submit CSRF protection (AGENTS.md section 10).
 *
 * Cookie auth is ambient: a browser attaches it to cross-site requests without
 * the page's consent. The defence is that unsafe requests must ALSO carry the
 * CSRF value in a header, which a cross-origin form or image request cannot set.
 *
 * Stateless by design - the header is compared against the readable cookie rather
 * than a server-side session store, which keeps the API horizontally scalable.
 * (The trade-off is that it assumes `SameSite=Lax` plus no subdomain
 * cookie-injection; both are enforced elsewhere.)
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly exemptPaths: Set<string>;

  constructor(
    @Inject(CSRF_OPTIONS) options: CsrfOptions,
    private readonly configService: ConfigService,
  ) {
    const configured = configService.get<string>('CSRF_EXEMPT_PATHS', '');
    const fromEnv = configured
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path !== '');
    this.exemptPaths = new Set([...options.exemptPaths, ...fromEnv]);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const method = request.method.toUpperCase();

    if (SAFE_METHODS.has(method) || this.isExempt(request)) {
      return true;
    }

    const cookies = request.cookies as Record<string, string> | undefined;
    const cookieToken = cookies?.[CSRF_COOKIE];

    const rawHeader = request.headers[CSRF_HEADER];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (typeof cookieToken !== 'string' || cookieToken === '') {
      throw new AppError(ERROR_CODES.CSRF_TOKEN_INVALID, 'Missing CSRF cookie');
    }
    if (typeof headerToken !== 'string' || headerToken === '') {
      throw new AppError(ERROR_CODES.CSRF_TOKEN_INVALID, 'Missing CSRF header');
    }
    if (!timingSafeEqual(cookieToken, headerToken)) {
      throw new AppError(ERROR_CODES.CSRF_TOKEN_INVALID, 'CSRF token mismatch');
    }

    return true;
  }

  /**
   * Matches exempt paths against both `request.path` and, when a global prefix
   * is applied, `originalUrl` with the prefix stripped.
   *
   * Guards run before routing, so `request.path` is whatever the client sent -
   * `/api/v1/auth/register`, not `/auth/register`. Matching on `path` alone
   * would silently stop exempting these routes as soon as the API prefix was
   * mounted, which is exactly the kind of change that only shows up as a 403
   * in production.
   */
  private isExempt(request: RequestWithAuth): boolean {
    const path = request.path;
    if (this.exemptPaths.has(path)) {
      return true;
    }

    // Strip a leading `/api/vN` segment if present.
    const withoutPrefix = path.replace(/^\/api\/v\d+(?=\/)/, '');
    return withoutPrefix !== path && this.exemptPaths.has(withoutPrefix);
  }
}
