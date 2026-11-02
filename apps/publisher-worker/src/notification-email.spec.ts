import type { EmailMessage, EmailSender } from '@renderflow/email';

import { PublishFailureEmailNotifier, type PublishFailureRecipients } from './notification-email';

/**
 * The notifications consumer is deliberately thin: validate, resolve, send.
 *
 * These tests pin the three behaviours that matter for a route which used to
 * dead-end: a valid event produces exactly one mail to the account's connector,
 * an invalid payload fails loudly instead of being silently skipped, and a
 * recipient deleted mid-flight is a no-op rather than an infinite retry.
 */

const EVENT = {
  eventType: 'post.publish_failed',
  postId: '11111111-1111-4111-8111-111111111111',
  publishJobId: '22222222-2222-4222-8222-222222222222',
  platform: 'linkedin',
  reason: 'access token expired',
};

function harness(
  recipient: { email: string; displayName: string | null } | null = {
    email: 'owner@example.com',
    displayName: 'Acme Studio',
  },
) {
  const sent: EmailMessage[] = [];
  const email: EmailSender = {
    send: async (message) => {
      sent.push(message);
    },
  };
  const find = jest.fn(async () => recipient ?? undefined);
  const recipients: PublishFailureRecipients = { find };

  const notifier = new PublishFailureEmailNotifier({
    recipients,
    email,
    dashboardUrl: 'https://app.renderflow.test/posts',
  });

  return { notifier, sent, find };
}

describe('PublishFailureEmailNotifier', () => {
  it('mails the account connector with the platform and reason', async () => {
    const { notifier, sent, find } = harness();

    await notifier.handle(EVENT);

    expect(find).toHaveBeenCalledWith(EVENT.publishJobId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: 'RenderFlow: linkedin publish failed',
    });
    expect(sent[0]?.text).toContain('Acme Studio (linkedin)');
    expect(sent[0]?.text).toContain('access token expired');
    expect(sent[0]?.text).toContain('https://app.renderflow.test/posts');
  });

  it('does not send when the account was deleted before the event was processed', async () => {
    // Retrying cannot make a deleted recipient appear, so this must drain
    // cleanly rather than burn the retry budget.
    const { notifier, sent, find } = harness(null);

    await notifier.handle(EVENT);

    expect(find).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('rejects a payload that is not a publish-failure event', async () => {
    // A malformed payload is a producer bug. Throwing leaves the failed job and
    // its payload visible in BullMQ instead of silently dropping it.
    const { notifier, sent } = harness();

    await expect(notifier.handle({ eventType: 'post.published' })).rejects.toThrow(
      /invalid post\.publish_failed payload/,
    );
    expect(sent).toHaveLength(0);
  });

  it('never includes the recipient address in the rejection message', async () => {
    // The mail body can carry account details; the error string is what ends up
    // in logs.
    const { notifier } = harness();

    await expect(notifier.handle({})).rejects.toThrow(/^invalid post\.publish_failed payload:/);
  });
});
