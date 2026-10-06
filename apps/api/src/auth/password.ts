import { createHash, randomBytes } from 'node:crypto';

/**
 * Password hashing and token digests for the auth module.
 *
 * Lives in apps/api rather than a lib because it is an authentication concern:
 * nothing in libs/credits, libs/queue or libs/workers needs to verify a password.
 */

export interface Argon2Options {
  /** Memory cost in KiB. */
  memoryCost: number;
  /** Time cost (passes). */
  timeCost: number;
  /** Parallelism. */
  parallelism: number;
}

/**
 * OWASP's minimum recommended argon2id parameters (m=19 MiB, t=2, p=1). These
 * are the defaults; `hashPassword` accepts overrides so tests can use cheap ones.
 */
export const DEFAULT_ARGON2_OPTIONS: Argon2Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Test-only: negligible cost, never used outside the test suite. */
export const FAST_ARGON2_OPTIONS: Argon2Options = {
  memoryCost: 8,
  timeCost: 1,
  parallelism: 1,
};

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Validates strength up front so a weak password is rejected before argon2 burns
 * ~50ms of CPU on it, and so the message can be specific.
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordPolicyError('Password is required');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // argon2 truncates very long input; reject rather than silently shorten.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) {
    throw new PasswordPolicyError('Password must contain a lowercase letter');
  }
  if (!/[A-Z]/.test(password)) {
    throw new PasswordPolicyError('Password must contain an uppercase letter');
  }
  if (!/\d/.test(password)) {
    throw new PasswordPolicyError('Password must contain a digit');
  }
}

/**
 * Hashes a password with argon2id.
 *
 * Returns a PHC-formatted string embedding the algorithm and parameters, so
 * parameters can be raised later without invalidating existing hashes.
 */
export async function hashPassword(
  password: string,
  options: Argon2Options = DEFAULT_ARGON2_OPTIONS,
): Promise<string> {
  assertPasswordPolicy(password);
  const { hash } = await import('argon2');
  return hash(password, {
    type: 2, // argon2id
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
  });
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash, so a corrupt row
 * cannot become a 500 that tells an attacker something.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof hash !== 'string' || hash === '') {
    return false;
  }
  try {
    const { verify } = await import('argon2');
    return await verify(hash, password);
  } catch {
    return false;
  }
}

/** Opaque, URL-safe refresh token: 32 bytes of entropy. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of a refresh token, hex encoded, matching the CHAR(64) column.
 *
 * A refresh token is high-entropy random, so a fast hash is correct here: there
 * is nothing to brute-force, and the goal is only that a database dump contains
 * no directly usable token.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  const digestA = createHash('sha256').update(bufferA).digest();
  const digestB = createHash('sha256').update(bufferB).digest();
  return digestA.equals(digestB);
}
