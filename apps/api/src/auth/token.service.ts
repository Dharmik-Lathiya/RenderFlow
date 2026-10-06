import { createHmac, randomBytes } from 'node:crypto';

import { AppError, ERROR_CODES } from '@renderflow/common';

/**
 * Signed access tokens.
 *
 * A stateless JWT so any API replica can validate a request without a shared
 * session store. It carries only identifiers - never the email, never a credit
 * balance, never a role that could be stale for the life of the token.
 *
 * Refresh tokens are opaque random strings stored hashed in Postgres. That
 * asymmetry is deliberate: a short-lived stateless access token plus a revocable
 * stateful refresh token gives both cheap verification and immediate revocation.
 */

export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  /** Token id, so a specific token can be traced in logs. */
  jti: string;
  role: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** Constant-time signature comparison; avoids leaking the match position. */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufferA.length; i += 1) {
    diff |= (bufferA[i] ?? 0) ^ (bufferB[i] ?? 0);
  }
  return diff === 0;
}

function hmac(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

export interface SignAccessTokenInput {
  userId: string;
  role: string;
  secret: string;
  ttlSeconds: number;
  now?: number;
}

export interface SignedAccessToken {
  token: string;
  expiresInSeconds: number;
  jti: string;
}

export function signAccessToken(input: SignAccessTokenInput): SignedAccessToken {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const jti = randomBytes(16).toString('hex');

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: input.userId,
      jti,
      role: input.role,
      iat: now,
      exp: now + input.ttlSeconds,
    }),
  );

  const signature = base64UrlEncode(hmac(`${header}.${payload}`, input.secret));
  return {
    token: `${header}.${payload}.${signature}`,
    expiresInSeconds: input.ttlSeconds,
    jti,
  };
}

export function verifyAccessToken(token: string, secret: string, now?: number): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Malformed access token');
  }

  const [header, payload, signature] = parts as [string, string, string];
  const expected = base64UrlEncode(hmac(`${header}.${payload}`, secret));

  if (!signaturesMatch(signature, expected)) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid access token signature');
  }

  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Malformed access token payload');
  }

  if (typeof claims !== 'object' || claims === null) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Malformed access token payload');
  }

  const record = claims as Record<string, unknown>;
  const currentSeconds = Math.floor((now ?? Date.now()) / 1000);

  if (typeof record.exp !== 'number' || record.exp <= currentSeconds) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Access token expired');
  }
  if (typeof record.sub !== 'string' || record.sub === '') {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Access token has no subject');
  }

  return {
    sub: record.sub,
    jti: typeof record.jti === 'string' ? record.jti : '',
    role: typeof record.role === 'string' ? record.role : 'MEMBER',
    iat: typeof record.iat === 'number' ? record.iat : 0,
    exp: record.exp,
  };
}

/**
 * Opaque CSRF token, also delivered in a readable cookie.
 *
 * This value is echoed by the browser in the `x-csrf-token` header, so it is not
 * a credential and is safe to hold in JS. It exists because a cross-site form
 * post cannot set a custom header, while it rides ambient cookies automatically.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}
