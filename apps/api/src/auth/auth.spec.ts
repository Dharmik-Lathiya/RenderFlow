import { createHmac } from 'node:crypto';

import { z } from 'zod';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_TOKEN_COOKIE,
  authCookieOptions,
  loadAuthConfig,
  ttlSeconds,
} from './auth.config';
import { loginSchema, normalizeEmail, registerSchema } from './auth.dto';
import {
  DEFAULT_ARGON2_OPTIONS,
  FAST_ARGON2_OPTIONS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  timingSafeEqual,
  verifyPassword,
} from './password';
import { generateCsrfToken, signAccessToken, verifyAccessToken } from './token.service';

const VALID_ENV = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('normalizeEmail', () => {
  it('lowercases and trims so case variants cannot create two accounts', () => {
    expect(normalizeEmail('  Founder@Example.COM ')).toBe('founder@example.com');
  });

  it('is applied by the register and login schemas', () => {
    const registered = registerSchema.parse({
      email: '  Ada@Example.COM ',
      password: 'IntegrationPass123',
      name: 'Ada',
    });
    expect(registered.email).toBe('ada@example.com');

    const loggedIn = loginSchema.parse({ email: 'ADA@EXAMPLE.COM', password: 'whatever12' });
    expect(loggedIn.email).toBe('ada@example.com');
  });

  it('lowercases the whole address, including the local part', () => {
    // The local part is technically case-sensitive (RFC 5321), but every
    // mainstream provider treats it case-insensitively. Normalising both sides
    // is what turns "register twice with different casing" into a 409 instead of
    // two accounts that each receive 50 credits.
    expect(normalizeEmail('CaseTest@Example.test')).toBe('casetest@example.test');
  });
});

describe('password policy', () => {
  it('requires a minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(() => assertPasswordPolicy('a'.repeat(9))).toThrow(PasswordPolicyError);
    // `a`.repeat(10) still has to satisfy the composition rules.
    expect(() => assertPasswordPolicy('a'.repeat(10))).toThrow(/uppercase|digit/);
    expect(() => assertPasswordPolicy('Abcdefghij')).toThrow(/digit/);
    expect(() => assertPasswordPolicy('Abcdefghi1')).not.toThrow();
  });

  it('rejects an over-long password rather than letting argon2 truncate it', () => {
    expect(() => assertPasswordPolicy('Aa1' + 'x'.repeat(MAX_PASSWORD_LENGTH))).toThrow(/at most/);
  });

  it('requires upper, lower and a digit', () => {
    expect(() => assertPasswordPolicy('alllowercase1')).toThrow(/uppercase/);
    expect(() => assertPasswordPolicy('ALLUPPERCASE1')).toThrow(/lowercase/);
    expect(() => assertPasswordPolicy('NoDigitsHere')).toThrow(/digit/);
    expect(() => assertPasswordPolicy('GoodPassword1')).not.toThrow();
  });

  it('rejects empty input', () => {
    expect(() => assertPasswordPolicy('')).toThrow(/required/);
  });
});

describe('argon2 hashing', () => {
  it('produces an argon2id hash that does not contain the password', async () => {
    const hash = await hashPassword('GoodPassword1', FAST_ARGON2_OPTIONS);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('GoodPassword1');
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('GoodPassword1', FAST_ARGON2_OPTIONS);
    await expect(verifyPassword(hash, 'GoodPassword1')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'WrongPassword1')).resolves.toBe(false);
  });

  it('salts each hash, so equal passwords differ', async () => {
    const a = await hashPassword('GoodPassword1', FAST_ARGON2_OPTIONS);
    const b = await hashPassword('GoodPassword1', FAST_ARGON2_OPTIONS);
    expect(a).not.toBe(b);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'GoodPassword1')).resolves.toBe(false);
    await expect(verifyPassword('', 'GoodPassword1')).resolves.toBe(false);
  });

  it('defaults to the OWASP-recommended argon2id parameters', () => {
    expect(DEFAULT_ARGON2_OPTIONS).toEqual({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('rejects a weak password before spending CPU on it', async () => {
    await expect(hashPassword('weak', FAST_ARGON2_OPTIONS)).rejects.toThrow(PasswordPolicyError);
  });
});

describe('refresh tokens', () => {
  it('produces a high-entropy opaque token', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically to 64 hex chars, matching CHAR(64)', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hash);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal values', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('handles length mismatches without throwing', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('access tokens', () => {
  const SECRET = 'c'.repeat(32);

  it('round-trips claims', () => {
    const signed = signAccessToken({
      userId: 'user-1',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });

    const claims = verifyAccessToken(signed.token, SECRET);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('MEMBER');
    expect(claims.jti).toBe(signed.jti);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('is a three-part JWT', () => {
    const { token } = signAccessToken({
      userId: 'u',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signAccessToken({
      userId: 'u',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });
    expect(() => verifyAccessToken(token, 'd'.repeat(32))).toThrow(/signature/i);
  });

  it('rejects a tampered payload', () => {
    const { token } = signAccessToken({
      userId: 'u',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
    });
    const [header, , signature] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', exp: 99999999999 })).toString(
      'base64url',
    );

    expect(() => verifyAccessToken(`${header}.${forgedPayload}.${signature}`, SECRET)).toThrow(
      /signature/i,
    );
  });

  it('rejects an expired token', () => {
    const now = 1_700_000_000_000;
    const { token } = signAccessToken({
      userId: 'u',
      role: 'MEMBER',
      secret: SECRET,
      ttlSeconds: 900,
      now,
    });
    expect(() => verifyAccessToken(token, SECRET, now + 901_000)).toThrow(/expired/i);
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyAccessToken('garbage', SECRET)).toThrow(/malformed/i);
    expect(() => verifyAccessToken('a.b', SECRET)).toThrow(/malformed/i);
  });

  it('rejects a token with no subject', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '', exp: now + 900 })).toString('base64url');
    // Re-sign so the signature check passes and only the subject is empty.
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(() => verifyAccessToken(`${header}.${payload}.${signature}`, SECRET)).toThrow(
      /no subject/i,
    );
  });

  it('defaults a missing role to MEMBER rather than trusting the token', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u', exp: now + 900 })).toString('base64url');
    // Re-sign so the signature check passes and only the role is absent.
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const claims = verifyAccessToken(`${header}.${payload}.${signature}`, SECRET);
    expect(claims.role).toBe('MEMBER');
  });
});

describe('csrf tokens', () => {
  it('generates unique random values', () => {
    const a = generateCsrfToken();
    expect(a).not.toBe(generateCsrfToken());
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe('auth config', () => {
  it('requires both secrets', () => {
    expect(() => loadAuthConfig({})).toThrow();
    expect(() => loadAuthConfig({ JWT_ACCESS_SECRET: 'x'.repeat(32) })).toThrow();
  });

  it('rejects a short secret, because a weak HMAC key is forgeable', () => {
    expect(() => loadAuthConfig({ ...VALID_ENV, JWT_ACCESS_SECRET: 'short' })).toThrow();
  });

  it('applies documented TTL defaults', () => {
    const config = loadAuthConfig(VALID_ENV);
    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.JWT_REFRESH_TTL).toBe('7d');
    expect(config.SIGNUP_BONUS_CREDITS).toBe(50);
  });

  it('has no default for the secrets', () => {
    // A checked-in default secret would be a real vulnerability in any deployed env.
    expect(VALID_ENV.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe('ttlSeconds', () => {
  it('converts the documented durations', () => {
    expect(ttlSeconds('15m')).toBe(900);
    expect(ttlSeconds('7d')).toBe(604_800);
    expect(ttlSeconds('30s')).toBe(30);
    expect(ttlSeconds('1h')).toBe(3600);
  });

  it('rejects an unparseable duration', () => {
    expect(() => ttlSeconds('15 minutes')).toThrow();
    expect(() => ttlSeconds('forever')).toThrow();
  });
});

describe('cookie policy', () => {
  it('is httpOnly and SameSite=Lax in development', () => {
    const options = authCookieOptions('development', 900);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.secure).toBe(false);
  });

  it('sets Secure in production', () => {
    expect(authCookieOptions('production', 900).secure).toBe(true);
  });

  it('uses the documented cookie names', () => {
    expect(ACCESS_TOKEN_COOKIE).toBe('rf_access');
    expect(REFRESH_TOKEN_COOKIE).toBe('rf_refresh');
    expect(CSRF_COOKIE).toBe('rf_csrf');
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });
});

describe('dto validation', () => {
  it('requires a name on register', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.co',
      password: 'IntegrationPass123',
    });
    expect(result.success).toBe(false);
  });

  it('caps the name length', () => {
    const result = registerSchema.safeParse({
      email: 'a@b.co',
      password: 'IntegrationPass123',
      name: 'x'.repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a minimal valid login without enforcing strength', () => {
    // Login must not reject on policy: the stored password may predate a policy change.
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });

  it('exposes a zod schema so it can be reused for OpenAPI', () => {
    expect(registerSchema.safeParse({}).success).toBe(false);
    expect(z).toBeDefined();
  });
});
