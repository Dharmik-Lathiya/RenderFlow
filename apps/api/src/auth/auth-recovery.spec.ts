import { forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema } from './auth.dto';

/**
 * Account-recovery input validation.
 *
 * The token itself is authenticated by the digest lookup, so these bounds are
 * about rejecting obviously-wrong input at the edge rather than about strength.
 * The password policy, however, is the real one: a reset must not be able to set
 * a password that registration would have refused.
 */
describe('forgotPasswordSchema', () => {
  it('normalises the address so casing cannot create a second account', () => {
    const parsed = forgotPasswordSchema.parse({ email: '  Person@Example.COM ' });
    expect(parsed.email).toBe('person@example.com');
  });

  it('rejects a malformed address', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a missing body', () => {
    expect(forgotPasswordSchema.safeParse({}).success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  const token = 'a'.repeat(43);

  it('accepts a token with a policy-compliant password', () => {
    expect(resetPasswordSchema.safeParse({ token, password: 'CorrectHorse1' }).success).toBe(true);
  });

  it('applies the same password policy as registration', () => {
    // A reset path that accepts a weaker password than signup is a downgrade
    // dressed as a recovery feature.
    expect(resetPasswordSchema.safeParse({ token, password: 'short' }).success).toBe(false);
  });

  it('rejects a token that could never match a digest', () => {
    expect(resetPasswordSchema.safeParse({ token: '', password: 'CorrectHorse1' }).success).toBe(
      false,
    );
    expect(
      resetPasswordSchema.safeParse({ token: 'x'.repeat(500), password: 'CorrectHorse1' }).success,
    ).toBe(false);
  });
});

describe('verifyEmailSchema', () => {
  it('trims the token, because a pasted link often carries whitespace', () => {
    const parsed = verifyEmailSchema.parse({ token: `  ${'a'.repeat(43)}  ` });
    expect(parsed.token).toBe('a'.repeat(43));
  });
});
