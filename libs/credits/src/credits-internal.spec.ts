import { assertIntegerCredits, isUniqueViolation, REFERENCE_TYPES } from './signup-bonus';

/**
 * Tests for the credit-lib helpers that do not need a database.
 *
 * The credit engine's SQL behaviour lives in tests/integration (it must run
 * against a real Postgres: CHECK constraints and partial unique indexes cannot be
 * mocked). What is covered here is the pure contract those functions depend on.
 */

describe('isUniqueViolation', () => {
  it('recognises the Postgres unique-violation SQLSTATE', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('still recognises the previous driver code', () => {
    // apps/api maps this to EMAIL_ALREADY_REGISTERED, so the predicate has to
    // keep covering the legacy shape.
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('sees through a wrapped cause, which node-postgres uses', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });

  it('does not treat other database errors as duplicates', () => {
    // 23503 is a foreign-key violation: retrying would not help, and treating
    // it as "already granted" would silently skip a required credit.
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation({ code: '23514' })).toBe(false);
  });

  it('is false for non-objects and unexpected shapes', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('23505'))).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation({ code: 23505 })).toBe(false);
    expect(isUniqueViolation({ code: null })).toBe(false);
  });

  it('does not loop forever on a self-referential cause', () => {
    const error: Record<string, unknown> = { code: 'other' };
    error.cause = error;
    expect(isUniqueViolation(error)).toBe(false);
  });
});

describe('assertIntegerCredits', () => {
  it('accepts the values the credit engine actually produces', () => {
    for (const amount of [0, 1, 5, 15, 30, 50, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertIntegerCredits(amount)).not.toThrow();
    }
  });

  it('rejects fractional credits', () => {
    // The invariant that makes SUM(ledger) === available + reserved exact.
    expect(() => assertIntegerCredits(12.5)).toThrow(/integer/);
    expect(() => assertIntegerCredits(0.1 + 0.2)).toThrow(/integer/);
  });

  it('rejects negatives and non-numbers', () => {
    expect(() => assertIntegerCredits(-1)).toThrow(/negative/);
    expect(() => assertIntegerCredits(Number.NaN)).toThrow();
    expect(() => assertIntegerCredits(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('names the field in the error', () => {
    expect(() => assertIntegerCredits(1.5, 'signup bonus')).toThrow(/signup bonus/);
  });
});

describe('REFERENCE_TYPES', () => {
  it('covers the idempotency scopes the credit engine uses', () => {
    // PROJECT.md section 5.10: every movement carries
    // (reference_type, reference_id, entry_type).
    expect(REFERENCE_TYPES.SYSTEM).toBe('SYSTEM');
    expect(REFERENCE_TYPES.JOB).toBe('JOB');
    expect(REFERENCE_TYPES.PURCHASE).toBe('PURCHASE');
    expect(REFERENCE_TYPES.ADMIN).toBe('ADMIN');
  });
});
