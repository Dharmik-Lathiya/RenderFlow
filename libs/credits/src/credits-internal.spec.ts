import { isUniqueViolation } from './signup-bonus';
import { CreditError, REFERENCE_TYPES, assertIntegerCredits } from './types';

/**
 * Tests for the credit-lib helpers that do not need a database.
 *
 * The credit engine's SQL behaviour lives in tests/integration (it must run
 * against a real Postgres: CHECK constraints and partial unique indexes cannot be
 * mocked). What is covered here is the pure contract those functions depend on.
 */

describe('isUniqueViolation', () => {
  it('recognises the Prisma unique-constraint error', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('does not treat other Prisma errors as duplicates', () => {
    // P2003 is a foreign-key violation: retrying would not help, and treating it
    // as "already granted" would silently skip a required credit.
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
  });

  it('is false for non-objects and unexpected shapes', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation({ code: 2002 })).toBe(false);
  });

  it('tolerates an object whose code is a non-string type', () => {
    // Structural narrowing, not truthiness: a number 2002 must not count.
    expect(isUniqueViolation({ code: null })).toBe(false);
    expect(isUniqueViolation({ code: undefined })).toBe(false);
    expect(isUniqueViolation({ code: ['P2002'] })).toBe(false);
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
    expect(() => assertIntegerCredits(12.5)).toThrow(CreditError);
    expect(() => assertIntegerCredits(0.1 + 0.2)).toThrow(/integer/);
  });

  it('rejects negatives and non-numbers', () => {
    expect(() => assertIntegerCredits(-1)).toThrow(/negative/);
    expect(() => assertIntegerCredits(Number.NaN)).toThrow(CreditError);
    expect(() => assertIntegerCredits(Number.POSITIVE_INFINITY)).toThrow(CreditError);
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
