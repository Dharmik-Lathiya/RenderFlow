import nodemailer from 'nodemailer';

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

/**
 * Resend's HTTP API.
 *
 * A plain `fetch` rather than their SDK: the API is one POST with a bearer
 * token, and a dependency that wraps one request is more supply-chain surface
 * than it is convenience.
 *
 * `fetchImpl` is injectable so the unit suite can assert the exact request
 * without opening a socket (AGENTS.md section 9: no real network in tests).
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly options: {
      apiKey: string;
      from: string;
      baseUrl: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/emails`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
      });
    } catch (error) {
      // The address and body stay out of the error: mail carries one-shot reset
      // tokens, and an error string is exactly what ends up in a log.
      throw new Error(
        `Resend request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Resend rejected the message (HTTP ${response.status}): ${body.slice(0, 500)}`,
      );
    }
  }
}

/** The shape `nodemailer`'s transport exposes; narrowed so tests can fake it. */
export interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * SMTP transport, used for the local MailHog container.
 *
 * This is a development transport, not a production one: MailHog accepts all
 * mail without authentication, and `assertEmailTransportIsSafe` refuses it when
 * `NODE_ENV=production`. A production SMTP relay should be a deliberate choice
 * with credentials and TLS, not an accidental fallback.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

export type EmailProvider = 'log' | 'none' | 'resend' | 'mailhog';

export interface EmailSenderOptions {
  /** RFC 5322 From header, e.g. `RenderFlow <no-reply@example.com>`. */
  from: string;
  resendApiKey?: string;
  resendBaseUrl?: string;
  mailhogHost?: string;
  mailhogPort?: number;
  /** Test seam for the Resend adapter. */
  fetchImpl?: typeof fetch;
  /** Test seam for the SMTP adapter. */
  smtpTransport?: SmtpTransport;
}

/** A provider that accepts a request and never answers must not hang a login. */
const EMAIL_SEND_TIMEOUT_MS = 10_000;

/**
 * Fails at boot rather than leaking at runtime.
 *
 * `log` writes a working password-reset link into the log stream. In production
 * that turns log access into account takeover, so it is not a configuration an
 * operator may choose by accident.
 *
 * `mailhog` is a local development SMTP tool; it must not be used in production
 * because it accepts all mail without authentication and discards nothing.
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
  if (options.nodeEnv === 'production' && options.provider === 'mailhog') {
    throw new Error(
      'EMAIL_PROVIDER=mailhog is a local development tool and is refused in production. ' +
        'Set EMAIL_PROVIDER=resend (or none) and configure RESEND_API_KEY.',
    );
  }
}

export function createEmailSender(
  provider: EmailProvider,
  options: Partial<EmailSenderOptions> = {},
): EmailSender {
  const from = options.from ?? 'RenderFlow <no-reply@renderflow.local>';

  switch (provider) {
    case 'log':
      return new LogEmailSender();
    case 'resend': {
      const apiKey = options.resendApiKey ?? '';
      if (apiKey === '') {
        // Fail at boot, not by silently dropping every reset mail: an operator
        // who selected Resend has to supply the key, and "forgot password does
        // nothing" is the exact failure this adapter exists to remove.
        throw new Error(
          'EMAIL_PROVIDER=resend requires RESEND_API_KEY. Set it, or use EMAIL_PROVIDER=none to drop mail explicitly.',
        );
      }
      return new ResendEmailSender({
        apiKey,
        from,
        baseUrl: options.resendBaseUrl ?? 'https://api.resend.com',
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    }
    case 'mailhog': {
      const transport =
        options.smtpTransport ??
        nodemailer.createTransport({
          host: options.mailhogHost ?? 'localhost',
          port: options.mailhogPort ?? 1025,
          // MailHog speaks plain SMTP and has no certificate. `ignoreTLS` stops
          // nodemailer from trying STARTTLS and failing the send.
          secure: false,
          ignoreTLS: true,
          connectionTimeout: EMAIL_SEND_TIMEOUT_MS,
          greetingTimeout: EMAIL_SEND_TIMEOUT_MS,
          socketTimeout: EMAIL_SEND_TIMEOUT_MS,
        });
      return new SmtpEmailSender(transport, from);
    }
    case 'none':
      return new DisabledEmailSender();
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unhandled email provider: ${String(exhaustive)}`);
    }
  }
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

/**
 * Text body for a terminal publish failure.
 *
 * The in-app notification is written by the publisher worker regardless of
 * whether mail is configured; this is the out-of-app copy for somebody who is
 * not watching the notification centre. It names the account because the fix -
 * reconnect that account - is per-account, not per-post.
 */
export function publishFailureEmail(input: {
  platform: string;
  displayName?: string | null;
  reason: string;
  dashboardUrl?: string;
}): Omit<EmailMessage, 'to'> {
  const account =
    input.displayName === undefined || input.displayName === null
      ? input.platform
      : `${input.displayName} (${input.platform})`;

  return {
    subject: `RenderFlow: ${input.platform} publish failed`,
    text: [
      `A scheduled post could not be published to ${account}.`,
      '',
      `Reason: ${input.reason}`,
      '',
      'The post is still in your calendar. Reconnect the account if its access',
      'has expired, then use the replay action on the post to try again.',
      ...(input.dashboardUrl === undefined ? [] : ['', `Open RenderFlow: ${input.dashboardUrl}`]),
    ].join('\n'),
  };
}
