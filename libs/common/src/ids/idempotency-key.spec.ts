import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  idempotencyKeySchema,
  isValidIdempotencyKey,
  parseIdempotencyKey,
} from './idempotency-key';

describe('idempotency keys', () => {
  it('uses the documented header name', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
  });

  it('accepts realistic client keys', () => {
    for (const key of [
      'req-01HZX9K2QW',
      'client:generate:42',
      '9f8b7a6c-1111-4222-8333-444455556666',
      'a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH),
    ]) {
      expect(isValidIdempotencyKey(key)).toBe(true);
    }
  });

  it('rejects keys that are too short to be meaningful', () => {
    expect(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1))).toBe(false);
    expect(isValidIdempotencyKey('')).toBe(false);
  });

  it('rejects keys beyond the maximum length', () => {
    expect(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects characters that would need escaping in a URL', () => {
    expect(isValidIdempotencyKey('has space key')).toBe(false);
    expect(isValidIdempotencyKey('has/slash')).toBe(false);
    expect(isValidIdempotencyKey('quote"key')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(12345678)).toBe(false);
  });

  it('parses a valid key and throws on an invalid one', () => {
    expect(parseIdempotencyKey('req-01HZX9K2QW')).toBe('req-01HZX9K2QW');
    expect(() => parseIdempotencyKey('short')).toThrow();
  });

  it('exposes the bounds it enforces', () => {
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBe(8);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(200);
    expect(idempotencyKeySchema.safeParse('req-01HZX9K2QW').success).toBe(true);
  });
});
