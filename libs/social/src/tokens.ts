import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Token encryption at rest (PROJECT.md section 12 Phase 7, AGENTS.md section 10:
 * "Encrypt social tokens at rest (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`).
 * Never return tokens from the API").
 *
 * A social token is a credential for somebody else's account. A database backup,
 * a replica, a `psql` session - any of those is a file that ends up somewhere it
 * should not, so the column holds ciphertext and the key lives in the
 * environment.
 *
 * AES-256-GCM rather than AES-CBC because it authenticates as well as encrypts.
 * CBC will happily decrypt a row somebody edited; GCM fails closed, which is the
 * difference between "someone cannot read our tokens" and "someone cannot learn
 * our tokens either".
 */

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
const VERSION = 'v1';

export interface TokenCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

/**
 * Reads `TOKEN_ENCRYPTION_KEY`, which must be 32 bytes base64-encoded.
 *
 * Failing at boot with the exact variable name is the difference between a
 * five-second fix and a deploy that starts, serves 500s, and is only diagnosed
 * when someone tries to connect an account.
 */
export function keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.TOKEN_ENCRYPTION_KEY;

  if (raw === undefined || raw.trim() === '') {
    throw new TokenCryptoError(
      'TOKEN_ENCRYPTION_KEY is required. Generate one with: openssl rand -base64 32',
    );
  }

  const key = Buffer.from(raw.trim(), 'base64');

  if (key.length !== 32) {
    throw new TokenCryptoError(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  return key;
}

export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) {
    throw new TokenCryptoError(`encryption key must be 32 bytes, got ${key.length}`);
  }

  return {
    encrypt(plaintext: string): string {
      // A fresh IV per token. Reusing an IV under GCM is catastrophic: it leaks
      // the XOR of two plaintexts and breaks the authentication key entirely.
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

      return [
        VERSION,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },

    decrypt(payload: string): string {
      const parts = payload.split('.');

      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new TokenCryptoError('token payload is not a recognised format');
      }

      const [ivPart, tagPart, dataPart] = parts.slice(1);

      if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
        throw new TokenCryptoError('token payload is missing a segment');
      }

      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));

      try {
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // Deliberately vague. "authentication tag mismatch" plus the row id is
        // all an attacker learns, which is fine; the plaintext of a forged blob is
        // not something this function can know about.
        throw new TokenCryptoError('token could not be decrypted with this key');
      }
    },
  };
}

export function tokenCipherFromEnv(env: NodeJS.ProcessEnv = process.env): TokenCipher {
  return createTokenCipher(keyFromEnv(env));
}

/**
 * Constant-time comparison for secrets.
 *
 * Not used for the auth tag - GCM checks that itself - but needed wherever a
 * webhook signature is compared by hand, because `===` on a signature leaks its
 * length and prefix through timing.
 */
export function secretsMatch(a: string, b: string): boolean {
  // Hashing first is what makes different lengths comparable at all:
  // `timingSafeEqual` throws on a length mismatch rather than comparing, so a
  // plain `===` is the only thing left and that leaks the length and prefix of
  // the secret through timing.
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
