import type { Request } from 'express';

/**
 * Request shape used by the auth routes.
 *
 * `cookies` and `user` are already widened onto Express's global `Request`
 * declaration in auth.guard.ts (cookie-parser and AuthGuard add them at runtime),
 * so this alias only exists to document what the auth layer guarantees.
 */
export type RequestWithAuth = Request;

/** Options accepted by Express's cookie helpers. */
export interface CookieSerializeOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  path?: string;
  maxAge?: number;
  domain?: string;
}

/**
 * Response with Express's cookie helpers.
 *
 * Express's own `Response` type already declares `cookie`/`clearCookie`; this
 * alias exists so the intent is obvious at the call site without re-declaring the
 * members and fighting the `this`-typing of the originals.
 */
export type ResponseWithCookies = import('express').Response;

/** Extracts the client IP for refresh-session auditing, honouring a proxy header. */
export function clientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded !== '') {
    // Left-most entry is the original client when a trusted proxy appends.
    return forwarded.split(',')[0]?.trim();
  }
  return request.ip ?? request.socket.remoteAddress ?? undefined;
}

/** Truncated user agent: enough to identify a device, short enough to store. */
export function clientUserAgent(request: Request): string | undefined {
  const raw = request.headers['user-agent'];
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  return raw.slice(0, 255);
}
