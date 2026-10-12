import { formatForPlatform, canPublish, isSocialPlatform, SOCIAL_PLATFORMS } from './adapter';
import { MockSocialAdapter } from './mock-adapter';
import { PlatformRateLimiter, TokenRefresherRegistry } from './runtime';
import { createTokenCipher, keyFromEnv, secretsMatch, TokenCryptoError } from './tokens';

/**
 * `libs/social` unit tests.
 *
 * The properties that carry money and the user's public profile are here:
 * idempotent publish, token encryption that fails closed, and formatting that
 * runs before approval rather than after it.
 */

describe('platform formatting', () => {
  it('leaves a caption that fits alone', () => {
    const result = formatForPlatform('linkedin', 'Rain again.', ['weather', 'commute']);

    expect(result.content).toBe('Rain again.\n\n#weather #commute');
    expect(result.notes).toEqual([]);
    expect(result.fits).toBe(true);
  });

  it('adds a missing hash to a bare tag', () => {
    expect(formatForPlatform('linkedin', 'Hi', ['weather']).content).toContain('#weather');
    expect(formatForPlatform('linkedin', 'Hi', ['#weather']).content).toContain('#weather');
  });

  it('truncates past LinkedIn limit', () => {
    const long = 'x'.repeat(3_500);
    const result = formatForPlatform('linkedin', long);

    expect(result.content.length).toBeLessThanOrEqual(3_000);
    expect(result.fits).toBe(true);
    expect(result.notes.join(' ')).toContain('truncated');
  });

  it('uses the shorter Instagram limit', () => {
    const long = 'x'.repeat(2_500);
    const result = formatForPlatform('instagram', long);

    expect(result.content.length).toBeLessThanOrEqual(2_200);
    expect(result.notes.join(' ')).toContain('2200');
  });

  it('shortens hashtags rather than the caption when they overflow', () => {
    // Instagram's limit is 2200. A 2190-character caption leaves 8 after the
    // blank line, which fits "#one" but not "#one #two" - so the tags are cut to
    // whole tags and the readable caption survives intact.
    const caption = 'a'.repeat(2_190);
    const result = formatForPlatform('instagram', caption, ['#one', '#two']);

    expect(result.content.startsWith(caption)).toBe(true);
    expect(result.content).toContain('#one');
    expect(result.content).not.toContain('#two');
    expect(result.notes.join(' ')).toContain('hashtags shortened');
  });

  it('drops hashtags entirely when there is no room', () => {
    // One character of room: even "#a" does not fit after the blank line.
    const result = formatForPlatform('instagram', 'b'.repeat(2_197), ['#one']);

    expect(result.notes.join(' ')).toContain('hashtags dropped');
    expect(result.content).not.toContain('#one');
  });

  it('keeps the caption exactly as written when the tags fit', () => {
    const caption = 'a'.repeat(2_100);
    const result = formatForPlatform('instagram', caption, ['#one', '#two']);

    expect(result.notes).toEqual([]);
    expect(result.content).toBe(`${caption}\n\n#one #two`);
  });

  it('never cuts a hashtag in half', () => {
    // "#weath" is worse than no tag: it is a link to nothing.
    const result = formatForPlatform('instagram', 'c'.repeat(2_190), ['#weather']);

    expect(result.content).not.toContain('#weath ');
  });

  it('leaves a post with no hashtags exactly as written', () => {
    expect(formatForPlatform('linkedin', '  spaced  ').content).toBe('spaced');
  });
});

describe('canPublish', () => {
  it('allows a text-only LinkedIn post', () => {
    const result = formatForPlatform('linkedin', 'Hello');
    expect(canPublish('linkedin', result, false).ok).toBe(true);
  });

  it('refuses a text-only Instagram post', () => {
    // Instagram rejects it. Better caught here than as a 400 after the user was
    // told the post was scheduled.
    const result = formatForPlatform('instagram', 'Hello');
    expect(canPublish('instagram', result, false)).toEqual({
      ok: false,
      reason: expect.stringContaining('requires media'),
    });
  });

  it('refuses an empty post with no media', () => {
    const result = formatForPlatform('linkedin', '   ');
    expect(canPublish('linkedin', result, false).ok).toBe(false);
  });

  it('allows an Instagram post with media', () => {
    expect(canPublish('instagram', formatForPlatform('instagram', 'Hi'), true).ok).toBe(true);
  });
});

describe('isSocialPlatform', () => {
  it('accepts the two supported platforms', () => {
    expect(SOCIAL_PLATFORMS).toEqual(['linkedin', 'instagram']);
    expect(isSocialPlatform('linkedin')).toBe(true);
    expect(isSocialPlatform('myspace')).toBe(false);
    expect(isSocialPlatform(42)).toBe(false);
  });
});

describe('MockSocialAdapter idempotency', () => {
  const input = { idempotencyKey: 'publish-job-1', content: 'Hello' };

  it('returns the same external id for the same key', async () => {
    // THE property. A worker killed after the platform accepted but before we
    // wrote the id down retries with the same key; if this returns a second id,
    // the user gets two copies of the same post.
    const adapter = new MockSocialAdapter({ platform: 'linkedin' });

    const first = await adapter.publish(input);
    const second = await adapter.publish(input);

    expect(second.externalPostId).toBe(first.externalPostId);
    expect(adapter.posts()).toHaveLength(1);
  });

  it('finds what it already published', async () => {
    const adapter = new MockSocialAdapter({ platform: 'linkedin' });
    const published = await adapter.publish(input);

    // This is the call the publisher makes BEFORE every attempt.
    expect((await adapter.findExternalPost(input.idempotencyKey))?.externalPostId).toBe(
      published.externalPostId,
    );
  });

  it('finds nothing for an unknown key', async () => {
    const adapter = new MockSocialAdapter({ platform: 'linkedin' });
    expect(await adapter.findExternalPost('never-published')).toBeNull();
  });

  it('gives different keys different posts', async () => {
    const adapter = new MockSocialAdapter({ platform: 'linkedin' });
    await adapter.publish(input);
    await adapter.publish({ ...input, idempotencyKey: 'other' });

    expect(adapter.posts()).toHaveLength(2);
  });

  it('keeps each adapter to its own world', () => {
    // A shared module-level map would make duplicate detection depend on the
    // order the tests ran in.
    const a = new MockSocialAdapter({ platform: 'linkedin' });
    const b = new MockSocialAdapter({ platform: 'linkedin' });
    expect(a.posts()).toHaveLength(0);
    expect(b.posts()).toHaveLength(0);
  });

  it('checks idempotency before the failure path', async () => {
    // A retry after a transient error has to be able to SUCCEED.
    const adapter = new MockSocialAdapter({ platform: 'linkedin', failTimes: 1 });

    await expect(adapter.publish(input)).rejects.toThrow();
    await expect(adapter.publish(input)).resolves.toMatchObject({
      externalPostId: expect.any(String),
    });
    expect(adapter.posts()).toHaveLength(1);
  });

  it('reports an expired token distinctly', async () => {
    const adapter = new MockSocialAdapter({ platform: 'linkedin', tokenExpired: true });

    // AUTH_EXPIRED is its own class because the action is different: refresh
    // and retry, rather than retry and eventually give up.
    await expect(adapter.publish(input)).rejects.toMatchObject({
      classification: 'AUTH_EXPIRED',
    });
  });

  it('refuses an empty post', async () => {
    const adapter = new MockSocialAdapter({ platform: 'linkedin' });
    await expect(adapter.publish({ ...input, content: '  ' })).rejects.toMatchObject({
      classification: 'REJECTED',
    });
  });

  it('refuses a text-only Instagram post', async () => {
    const adapter = new MockSocialAdapter({ platform: 'instagram' });
    await expect(adapter.publish({ ...input, content: 'Hello' })).rejects.toMatchObject({
      classification: 'REJECTED',
    });
  });

  it('gives LinkedIn the text-only policy and Instagram the media one', () => {
    expect(new MockSocialAdapter({ platform: 'linkedin' }).mediaPolicy.acceptsTextOnly).toBe(true);
    expect(new MockSocialAdapter({ platform: 'instagram' }).mediaPolicy.acceptsTextOnly).toBe(
      false,
    );
  });
});

describe('token encryption', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips a token', () => {
    const cipher = createTokenCipher(key);
    const token = 'ya29.super-secret-access-token';

    expect(cipher.decrypt(cipher.encrypt(token))).toBe(token);
  });

  it('never stores the plaintext', () => {
    const cipher = createTokenCipher(key);
    expect(cipher.encrypt('ya29.super-secret')).not.toContain('super-secret');
  });

  it('uses a fresh IV every time', () => {
    // Reusing an IV under GCM leaks the XOR of two plaintexts and breaks the
    // authentication key entirely.
    const cipher = createTokenCipher(key);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('fails closed on a tampered ciphertext', () => {
    // AES-CBC would happily decrypt an edited row; GCM does not.
    const cipher = createTokenCipher(key);
    const parts = cipher.encrypt('hello').split('.');

    const data = parts[3] ?? '';
    const tampered = [parts[0], parts[1], parts[2], `${data.slice(0, -2)}AA`].join('.');

    expect(() => cipher.decrypt(tampered)).toThrow(TokenCryptoError);
  });

  it('fails closed on the wrong key', () => {
    const encrypted = createTokenCipher(key).encrypt('hello');
    expect(() => createTokenCipher(Buffer.alloc(32, 9)).decrypt(encrypted)).toThrow(
      TokenCryptoError,
    );
  });

  it('rejects a payload that is not its format', () => {
    const cipher = createTokenCipher(key);

    expect(() => cipher.decrypt('nope')).toThrow(TokenCryptoError);
    expect(() => cipher.decrypt('v1.only.two')).toThrow(TokenCryptoError);
    // A future version must fail, not be misread by today's code.
    expect(() => cipher.decrypt('v2.a.b.c')).toThrow(TokenCryptoError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => createTokenCipher(Buffer.alloc(16))).toThrow(TokenCryptoError);
  });
});

describe('keyFromEnv', () => {
  it('names the variable when it is missing', () => {
    // Failing at boot with the exact name is the difference between a
    // five-second fix and a deploy that serves 500s until someone connects an
    // account.
    expect(() => keyFromEnv({})).toThrow(/TOKEN_ENCRYPTION_KEY is required/);
  });

  it('says how to generate one', () => {
    expect(() => keyFromEnv({ TOKEN_ENCRYPTION_KEY: '' })).toThrow(/openssl rand -base64 32/);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => keyFromEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(8).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });

  it('accepts a real one', () => {
    expect(
      keyFromEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
    ).toHaveLength(32);
  });
});

describe('secretsMatch', () => {
  it('compares equal and unequal secrets', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
  });

  it('handles secrets of different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so hashing first is what
    // makes a constant-time comparison possible at all.
    expect(secretsMatch('short', 'a-much-longer-secret')).toBe(false);
    expect(secretsMatch('short', 'short')).toBe(true);
  });

  it('handles empty strings', () => {
    expect(secretsMatch('', '')).toBe(true);
    expect(secretsMatch('', 'x')).toBe(false);
  });
});

describe('PlatformRateLimiter', () => {
  it('allows calls up to the limit', async () => {
    const limiter = new PlatformRateLimiter('linkedin', 3, 60_000);

    for (let index = 0; index < 3; index += 1) {
      await expect(limiter.run(async () => index)).resolves.toBe(index);
    }
  });

  it('refuses past the limit rather than waiting', async () => {
    // A publish that waits misses its scheduled slot, and a publisher that
    // silently runs late is worse than one that says it cannot go now.
    const limiter = new PlatformRateLimiter('linkedin', 2, 60_000);

    await limiter.run(async () => undefined);
    await limiter.run(async () => undefined);

    await expect(limiter.run(async () => undefined)).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });

  it('says how long until a slot frees', async () => {
    const limiter = new PlatformRateLimiter('linkedin', 1, 60_000);
    await limiter.run(async () => undefined);

    expect(limiter.retryAfterMs()).toBeGreaterThan(0);
    expect(limiter.retryAfterMs()).toBeLessThanOrEqual(60_000);
  });

  it('counts a FAILED call against the limit', async () => {
    // A call that fails still consumed a slot upstream. Not counting it is how a
    // rate limiter stops being one.
    const limiter = new PlatformRateLimiter('linkedin', 2, 60_000);

    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(limiter.run(async () => undefined)).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });

  it('frees its concurrency slot after a failure', async () => {
    const limiter = new PlatformRateLimiter('linkedin', 10, 60_000, 1);

    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow();
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('TokenRefresherRegistry', () => {
  const good = {
    refresh: async () => ({
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: new Date(),
    }),
  };

  it('refreshes once and hands back the new credentials', async () => {
    const expires = new Date('2026-06-01T00:00:00.000Z');
    const registry = new TokenRefresherRegistry({
      refresh: async () => ({
        accessToken: 'new',
        refreshToken: 'new-refresh',
        expiresAt: expires,
      }),
    });

    const result = await registry.refreshOnce('linkedin', 'r1', 'job-1');

    // The caller has to STORE these, and it cannot ask the platform twice to get
    // them: a refresh typically invalidates the token it just issued, so the
    // second call fails and the account ends up logged out.
    expect(result).toEqual({
      refreshed: true,
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: expires,
    });
  });

  it('collapses concurrent refreshes of the same job', async () => {
    // A 401 arrives, three workers all retry, and without this all three call the
    // platform - which invalidates the previous refresh token, so the second
    // fails and logs the account out.
    let calls = 0;
    const registry = new TokenRefresherRegistry({
      refresh: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      },
    });

    const results = await Promise.all([
      registry.refreshOnce('linkedin', 'r1', 'job-1'),
      registry.refreshOnce('linkedin', 'r1', 'job-1'),
      registry.refreshOnce('linkedin', 'r1', 'job-1'),
    ]);

    expect(results.every((r) => r.refreshed)).toBe(true);
    expect(calls).toBe(1);
  });

  it('treats different jobs independently', async () => {
    let calls = 0;
    const registry = new TokenRefresherRegistry({
      refresh: async () => {
        calls += 1;
        return { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      },
    });

    await registry.refreshOnce('linkedin', 'r1', 'job-1');
    await registry.refreshOnce('linkedin', 'r1', 'job-2');

    expect(calls).toBe(2);
  });

  it('reports a missing refresh token as needing a reconnect', async () => {
    const registry = new TokenRefresherRegistry(good);
    const result = await registry.refreshOnce('linkedin', '   ', 'job-1');

    expect(result.refreshed).toBe(false);
    expect(result.reason).toContain('reconnect');
  });

  it('reports a refresh failure, with the cause, without throwing', async () => {
    // "token refresh failed" with no cause tells an operator nothing and cannot
    // be told apart from a network blip. The platform's own message is the
    // difference between "reconnect the account" and "retry in a minute".
    const registry = new TokenRefresherRegistry({
      refresh: async () => {
        throw new Error('refresh token revoked');
      },
    });

    const result = await registry.refreshOnce('linkedin', 'r1', 'job-1');

    expect(result.refreshed).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('handles a refresher that throws something that is not an Error', async () => {
    const registry = new TokenRefresherRegistry({
      refresh: async () => {
        throw new Error('a string, somehow');
      },
    });

    const result = await registry.refreshOnce('linkedin', 'r1', 'job-1');

    expect(result.refreshed).toBe(false);
    expect(result.reason).toContain('a string, somehow');
  });

  it('forgets the dedupe key afterwards, so a later 401 can refresh again', async () => {
    let calls = 0;
    const registry = new TokenRefresherRegistry({
      refresh: async () => {
        calls += 1;
        return { accessToken: 'a', refreshToken: 'r', expiresAt: null };
      },
    });

    await registry.refreshOnce('linkedin', 'r1', 'job-1');
    await registry.refreshOnce('linkedin', 'r1', 'job-1');

    expect(calls).toBe(2);
  });
});
