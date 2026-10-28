import { createLogger } from '@renderflow/observability';

/**
 * Transactional email, behind a seam.
 *
 * The product needs to send exactly three things today - a password reset link, an
 * email-verification link, and a publish-failure notice - and it has no provider
 * configured. Rather than pretend, this module defines the interface and a
 * development transport that writes the message to the log, and refuses to run
 * that transport in production (see `assertEmailTransportIsSafe`).
 *
 * A real provider is one small class implementing `EmailSender` (an HTTP POST to
 * Resend/Postmark/SES, or an SMTP client) plus a swap in `email.module.ts`. The
 * call sites do not change.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Development transport: logs the whole message, including the link.
 *
 * That is the point - a developer runs the reset flow and reads the link from the
 * console. It is also why this is banned in production: the body contains a usable
 * one-shot token, and AGENTS.md forbids logging secrets.
 */
export class LogEmailSender implements EmailSender {
  // Created on first send, not in the constructor: building a logger opens a
  // transport, and a unit test that only constructs the transport should not have
  // to close one.
  private log: ReturnType<typeof createLogger> | null = null;

  send(message: EmailMessage): Promise<void> {
    this.log ??= createLogger({ service: 'email' });
    this.log.info(
      { to: message.to, subject: message.subject, body: message.text },
      'email transport is "log": nothing was sent, and the body contains a one-shot token',
    );
    return Promise.resolve();
  }
}

/** Explicitly off. Used in tests and in a deployment that has no mail provider yet. */
export class DisabledEmailSender implements EmailSender {
  private log: ReturnType<typeof createLogger> | null = null;
  private warned = false;

  send(message: EmailMessage): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      this.log ??= createLogger({ service: 'email' });
      this.log.warn(
        { to: message.to, subject: message.subject },
        'EMAIL_PROVIDER=none: message dropped. Configure a provider transport before launch.',
      );
    }
    return Promise.resolve();
  }
}

export type EmailProvider = 'log' | 'none';

/**
 * Fails at boot rather than leaking at runtime.
 *
 * `log` writes a working password-reset link into the log stream. In production
 * that turns log access into account takeover, so it is not a configuration an
 * operator may choose by accident.
 */
export function assertEmailTransportIsSafe(options: {
  nodeEnv: string;
  provider: EmailProvider;
}): void {
  if (options.nodeEnv === 'production' && options.provider === 'log') {
    throw new Error(
      'EMAIL_PROVIDER=log writes one-shot tokens to the log and is refused in production. ' +
        'Configure a real transport, or set EMAIL_PROVIDER=none to drop mail explicitly.',
    );
  }
}

export function createEmailSender(provider: EmailProvider): EmailSender {
  return provider === 'log' ? new LogEmailSender() : new DisabledEmailSender();
}

/** Text body for a password reset. Kept here so the wording has one definition. */
export function passwordResetEmail(link: string, ttlMinutes: number): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Reset your RenderFlow password',
    text: [
      'Someone asked to reset the password for this RenderFlow account.',
      '',
      `Open this link to choose a new password (valid for ${ttlMinutes} minutes):`,
      link,
      '',
      'If this was not you, ignore this message - your password has not changed.',
    ].join('\n'),
  };
}

/** Text body for email verification. */
export function verificationEmail(link: string, ttlHours: number): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Confirm your RenderFlow email address',
    text: [
      'Confirm this address to finish setting up your RenderFlow account.',
      '',
      `Open this link (valid for ${ttlHours} hours):`,
      link,
      '',
      'If you did not create an account, ignore this message.',
    ].join('\n'),
  };
}
