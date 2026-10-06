import { CreditError, assertIntegerCredits, signupBonusCredits } from './types';

/**
 * Pure unit tests for the credit rules that need no database
 * (PROJECT.md section 13.1: "credit math").
 */
describe('assertIntegerCredits', () => {
  it('accepts non-negative integers', () => {
    expect(() => assertIntegerCredits(0)).not.toThrow();
    expect(() => assertIntegerCredits(1)).not.toThrow();
    expect(() => assertIntegerCredits(50)).not.toThrow();
  });

  it('rejects fractional credits', () => {
    // Credits are integers only (AGENTS.md section 7). A float would make
    // SUM(ledger) == available + reserved inexact.
    expect(() => assertIntegerCredits(1.5)).toThrow(CreditError);
    expect(() => assertIntegerCredits(0.1 + 0.2)).toThrow(/integer/);
  });

  it('rejects negatives', () => {
    expect(() => assertIntegerCredits(-1)).toThrow(/must not be negative/);
  });

  it('rejects values beyond safe integer range', () => {
    expect(() => assertIntegerCredits(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => assertIntegerCredits(Number.NaN)).toThrow(CreditError);
    expect(() => assertIntegerCredits(Number.POSITIVE_INFINITY)).toThrow(CreditError);
  });

  it('names the field in the error', () => {
    expect(() => assertIntegerCredits(1.5, 'signup bonus')).toThrow(/signup bonus/);
  });
});

describe('signupBonusCredits', () => {
  it('reads the amount from configuration', () => {
    expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '50' })).toBe(50);
    expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '0' })).toBe(0);
    expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '1000' })).toBe(1000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '  75  ' })).toBe(75);
  });

  it('throws rather than defaulting when unset', () => {
    // Defaulting to 0 would silently look like a credit-engine bug.
    expect(() => signupBonusCredits({})).toThrow(CreditError);
    expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: '' })).toThrow(/not configured/);
  });

  it('rejects a non-integer or negative configured amount', () => {
    expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: '12.5' })).toThrow(CreditError);
    expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: '-10' })).toThrow(CreditError);
    expect(() => signupBonusCredits({ SIGNUP_BONUS_CREDITS: 'lots' })).toThrow(CreditError);
  });

  it('never returns a hardcoded 50 from logic', () => {
    // The literal must come from config (AGENTS.md rule 6).
    expect(signupBonusCredits({ SIGNUP_BONUS_CREDITS: '7' })).toBe(7);
  });
});

describe('isUniqueViolation', () => {
  it('recognises Prisma P2002', async () => {
    const { isUniqueViolation } = await import('./signup-bonus');
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
  });
});
