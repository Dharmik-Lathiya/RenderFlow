import {
  DisabledEmailSender,
  LogEmailSender,
  assertEmailTransportIsSafe,
  createEmailSender,
  passwordResetEmail,
  verificationEmail,
} from './email';

/**
 * The transport guard is a security control, not a convenience.
 *
 * `LogEmailSender` prints the reset link, which is a working credential. It is
 * useful locally and unacceptable in production, so the boot check is tested like
 * a validator rather than left to a comment.
 */
describe('assertEmailTransportIsSafe', () => {
  it('refuses the log transport in production', () => {
    // A production deployment that keeps the development default would write
    // usable password-reset links into its log stream.
    expect(() => assertEmailTransportIsSafe({ nodeEnv: 'production', provider: 'log' })).toThrow(
      /EMAIL_PROVIDER=log/,
    );
  });

  it('allows the log transport outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() => assertEmailTransportIsSafe({ nodeEnv, provider: 'log' })).not.toThrow();
    }
  });

  it('allows an explicitly disabled transport in production', () => {
    // Dropping mail is a choice a deployment may make; leaking tokens is not.
    expect(() =>
      assertEmailTransportIsSafe({ nodeEnv: 'production', provider: 'none' }),
    ).not.toThrow();
  });
});

describe('createEmailSender', () => {
  it('maps the log provider to the logging transport', () => {
    expect(createEmailSender('log')).toBeInstanceOf(LogEmailSender);
  });

  it('maps none to the dropping transport', () => {
    expect(createEmailSender('none')).toBeInstanceOf(DisabledEmailSender);
  });
});

describe('email bodies', () => {
  it('puts the reset link and its lifetime in the message', () => {
    const message = passwordResetEmail('https://app.test/reset-password?token=abc', 30);

    expect(message.subject).toMatch(/reset/i);
    expect(message.text).toContain('https://app.test/reset-password?token=abc');
    expect(message.text).toContain('30 minutes');
  });

  it('tells the recipient what to do if the request was not theirs', () => {
    // The most important sentence in a reset mail: it doubles as the only
    // phishing signal a user gets.
    expect(passwordResetEmail('https://app.test/x', 30).text).toMatch(/not you/i);
  });

  it('gives the verification link its own lifetime', () => {
    const message = verificationEmail('https://app.test/verify-email?token=abc', 48);

    expect(message.subject).toMatch(/confirm/i);
    expect(message.text).toContain('48 hours');
  });
});
