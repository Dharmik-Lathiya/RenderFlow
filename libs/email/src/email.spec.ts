import {
  DisabledEmailSender,
  LogEmailSender,
  ResendEmailSender,
  SmtpEmailSender,
  assertEmailTransportIsSafe,
  createEmailSender,
  passwordResetEmail,
  verificationEmail,
  type SmtpTransport,
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

  it('refuses resend without an API key instead of silently dropping mail', () => {
    // A misconfigured production deployment would otherwise lose every password
    // reset while reporting success. Failing at boot is visible immediately.
    expect(() => createEmailSender('resend')).toThrow(/RESEND_API_KEY/);
  });

  it('builds a mailhog transport from the configured SMTP endpoint', () => {
    const transport: SmtpTransport = { sendMail: jest.fn() };
    expect(
      createEmailSender('mailhog', { smtpTransport: transport, from: 'RF <rf@test>' }),
    ).toBeInstanceOf(SmtpEmailSender);
  });
});

describe('ResendEmailSender', () => {
  it('posts the message with a bearer token', async () => {
    const fetchImpl = jest.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    const sender = new ResendEmailSender({
      apiKey: 're_test_key',
      from: 'RenderFlow <no-reply@example.com>',
      baseUrl: 'https://api.test/',
      fetchImpl,
    });

    await sender.send({ to: 'user@example.com', subject: 'Reset', text: 'Body' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'RenderFlow <no-reply@example.com>',
      to: ['user@example.com'],
      subject: 'Reset',
      text: 'Body',
    });
  });

  it('throws on a rejected request so the caller can log it', async () => {
    const fetchImpl = jest.fn(
      async () => new Response('{"message":"invalid api key"}', { status: 401 }),
    );
    const sender = new ResendEmailSender({
      apiKey: 'bad',
      from: 'RF <rf@test>',
      baseUrl: 'https://api.test',
      fetchImpl,
    });

    await expect(
      sender.send({ to: 'user@example.com', subject: 'Reset', text: 'Body' }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('SmtpEmailSender', () => {
  it('hands the message to the SMTP transport with the configured From', async () => {
    const sendMail = jest.fn(async () => ({ accepted: ['user@example.com'] }));
    const sender = new SmtpEmailSender({ sendMail }, 'RenderFlow <no-reply@example.com>');

    await sender.send({ to: 'user@example.com', subject: 'Verify', text: 'Body' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'RenderFlow <no-reply@example.com>',
      to: 'user@example.com',
      subject: 'Verify',
      text: 'Body',
    });
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
