import { Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  ProviderError,
  createModerator,
  type Moderator,
  type ModerationVerdict,
} from '@renderflow/ai';
import { ModerationRejectedError } from '@renderflow/common';
import { getDb, posts, type Database } from '@renderflow/db';

/**
 * Moderation, before any credits move (PROJECT.md section 12 Phase 6: "Moderation
 * check before reserve").
 *
 * It runs here, in the request path, for two reasons:
 *
 *  - **Before the reservation.** A reservation taken for a request that is then
 *    refused has to be refunded, and a refund the user never needed is a balance
 *    that moved for no reason. Checked first, a refused request never touches
 *    the wallet at all.
 *  - **On the post's own text.** What is being moderated is what the user
 *    already wrote and is about to publish. Moderating the eventual model output
 *    instead would be far too late: the credits would be reserved and the job
 *    queued.
 *
 * The provider-backed check is ADDITIVE and optional. The local rules always run,
 * in every environment, which is what makes "moderation runs on every request" a
 * property of the code rather than of a configuration that might be switched off.
 */

export const moderationInputSchema = z.object({
  /** The post being generated for. Its caption is part of what is checked. */
  postId: z.string().uuid(),
  /** Anything else the caller supplied that will shape the output. */
  prompt: z.string().trim().max(4_000).default(''),
  kind: z.string().trim().max(40).default('GENERATION'),
});

export type ModerationInput = z.infer<typeof moderationInputSchema>;

export interface ModerationOutcome {
  allowed: boolean;
  source: string;
  /** True when the provider check could not be reached and the local rules stood alone. */
  providerUnavailable: boolean;
}

@Injectable()
export class ModerationService implements OnModuleInit {
  private db!: Database;
  private moderator: Moderator = createModerator();

  onModuleInit(): void {
    this.db = getDb();
    this.moderator = createModerator(
      // Constructed with a key only when one exists, so a local setup with no
      // provider still runs the local rules and still generates.
      process.env.OPENAI_API_KEY === undefined ? {} : { apiKey: process.env.OPENAI_API_KEY },
    );
  }

  /** Test seam, so a suite can drive a specific verdict. */
  setModerator(moderator: Moderator): void {
    this.moderator = moderator;
  }

  /**
   * Throws `ModerationRejectedError` (422) when the content is refused.
   *
   * A TRANSIENT moderation outage does not block the request. The local rules
   * have already run and passed, the content is the user's own, and refusing
   * every request because a third party is down takes the whole product out. The
   * outage is reported through `providerUnavailable` so it is visible rather
   * than swallowed.
   *
   * A refusal from the provider IS honoured, and it is not overridable: the
   * local rules have no way to un-refuse, and neither does anything else.
   */
  async assertAllowed(input: ModerationInput): Promise<ModerationOutcome> {
    const parsed = moderationInputSchema.parse(input);
    const caption = await this.captionOf(parsed.postId);

    const text = [parsed.prompt, caption].filter((part) => part !== '').join('\n');

    let verdict: ModerationVerdict;
    let providerUnavailable = false;

    try {
      verdict = await this.moderator.moderate({ text, kind: parsed.kind });
    } catch (error) {
      if (error instanceof ProviderError && error.classification === 'TRANSIENT') {
        providerUnavailable = true;
        verdict = { allowed: true, source: 'local-only' };
      } else {
        throw error;
      }
    }

    if (!verdict.allowed) {
      throw new ModerationRejectedError(verdict.reason ?? 'content refused');
    }

    return { allowed: true, source: verdict.source, providerUnavailable };
  }

  /**
   * The post's caption.
   *
   * Fetched by id, and only AFTER the caller's membership in the owning
   * workspace has been checked by `JobsService`. The service does not re-check
   * tenancy itself: there is one place that resolves a post's workspace, and a
   * second copy is a second chance to get it wrong.
   */
  private async captionOf(postId: string): Promise<string> {
    const rows = await this.db
      .select({ caption: posts.caption })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    return rows[0]?.caption ?? '';
  }
}
