import { eq } from 'drizzle-orm';

import { postPublishFailedEventSchema } from '@renderflow/common';
import { publishJobs, socialAccounts, users, type Database } from '@renderflow/db';
import { publishFailureEmail, type EmailSender } from '@renderflow/email';

/** Who to tell about a failed publish. */
export interface PublishFailureRecipient {
  email: string;
  displayName: string | null;
}

/**
 * Resolves the recipient, separately from sending.
 *
 * The split is what lets the decision logic (validate the event, skip a deleted
 * account, do not send to the wrong person) be tested without a database, while
 * the query itself stays a plain Drizzle read.
 */
export interface PublishFailureRecipients {
  find(publishJobId: string): Promise<PublishFailureRecipient | undefined>;
}

export class DrizzlePublishFailureRecipients implements PublishFailureRecipients {
  constructor(private readonly db: Database) {}

  async find(publishJobId: string): Promise<PublishFailureRecipient | undefined> {
    const rows = await this.db
      .select({
        email: users.email,
        displayName: socialAccounts.displayName,
      })
      .from(publishJobs)
      .innerJoin(socialAccounts, eq(socialAccounts.id, publishJobs.socialAccountId))
      .innerJoin(users, eq(users.id, socialAccounts.connectedBy))
      .where(eq(publishJobs.id, publishJobId))
      .limit(1);

    return rows[0];
  }
}

/**
 * The consumer behind the `notifications` queue (ARCH-05).
 *
 * The outbox routes `post.publish_failed` here, and until this existed the
 * route was a dead end: BullMQ accumulated messages nothing drained, and after
 * the retry budget they surfaced in the abandoned-events DLQ as noise. The
 * in-app notification is still written directly by the publisher worker,
 * because that must not depend on a second process being alive; this is the
 * out-of-app copy.
 *
 * Recipient resolution mirrors `PublishProcessor.notifyFailure`: the person who
 * connected the social account, not the post's author or the workspace owner.
 * They are the one who can reconnect it.
 *
 * Delivery semantics are at-least-once. The outbox itself is exactly-once via
 * its dedupe key, and BullMQ's deterministic job id collapses duplicate
 * deliveries while the job is still in Redis. A worker killed after the
 * provider accepted a message but before the job completed can resend it on
 * retry; for a failure notice that is the correct trade - losing the mail is
 * worse than a rare duplicate.
 */
export class PublishFailureEmailNotifier {
  constructor(
    private readonly options: {
      recipients: PublishFailureRecipients;
      email: EmailSender;
      /** Used in the mail body; no request context exists in a worker. */
      dashboardUrl: string;
    },
  ) {}

  async handle(payload: unknown): Promise<void> {
    const parsed = postPublishFailedEventSchema.safeParse(payload);

    if (!parsed.success) {
      // A malformed payload is a producer bug, not a transient outage. Throwing
      // lets BullMQ record the failure with its attempts and payload intact,
      // which is what makes it diagnosable; silently dropping it hides the bug.
      throw new Error(
        `invalid post.publish_failed payload: ${parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.code)
          .join(', ')}`,
      );
    }

    const event = parsed.data;
    const recipient = await this.options.recipients.find(event.publishJobId);

    if (recipient === undefined) {
      // The account (or the user) was deleted while the event was in flight.
      // There is nobody to tell, and retrying cannot change that.
      return;
    }

    await this.options.email.send({
      to: recipient.email,
      ...publishFailureEmail({
        platform: event.platform,
        displayName: recipient.displayName,
        reason: event.reason,
        dashboardUrl: this.options.dashboardUrl,
      }),
    });
  }
}
