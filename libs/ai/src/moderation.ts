import { z } from 'zod';

import { ProviderError } from './providers';
import type { FetchLike } from './text-providers';

/**
 * Moderation, checked BEFORE credits are reserved (PROJECT.md section 12 Phase 6,
 * AGENTS.md section 8: "Run moderation before reserving credits").
 *
 * Before, not after, for one reason that has nothing to do with safety policy:
 * a reservation taken for a request that is then refused has to be refunded, and
 * a refunded reservation the user never needed is a balance that briefly moves
 * for no reason. Checking first means a refused request never touches the wallet.
 *
 * The default implementation is a LOCAL, deterministic rule set, not a model. It
 * runs in every environment including the one where `AI_PROVIDER=mock`, which is
 * what makes "moderation runs on every request" a testable claim rather than a
 * configuration that might be switched off.
 */

export interface ModerationVerdict {
  allowed: boolean;
  /** Present only when refused. Safe to show a user. */
  reason?: string;
  /** Which rule or provider decided. For logs and for the admin surface. */
  source: string;
}

export interface ModerationInput {
  text: string;
  /** What the content is for, so a rule can be specific about it. */
  kind: string;
  brandId?: string | null;
}

export interface Moderator {
  readonly name: string;
  moderate(input: ModerationInput): Promise<ModerationVerdict>;
}

/**
 * Terms refused outright.
 *
 * Deliberately short and deliberately obvious. A local filter that tries to be
 * clever about what counts as a slur becomes a thing that has to be explained to
 * a customer support team; one that refuses an exact list is a thing nobody has
 * to reason about. The provider-backed moderator below is where nuance belongs.
 */
export const BLOCKED_TERMS: readonly string[] = [
  'explicit sexual content',
  'child sexual abuse material',
  'doxxing',
  'hate symbol',
];

/**
 * A local, deterministic moderator.
 *
 * Matches on the normalised text so `E xplicit` and `EXPLICIT` are the same
 * refusal. Normalisation is why a list checked against raw text is easy to walk
 * past with nothing more than a capital E.
 */
export class LocalModerator implements Moderator {
  readonly name = 'local';

  constructor(private readonly terms: readonly string[] = BLOCKED_TERMS) {}

  // Synchronous by nature - a list walk - but it returns a Promise because that
  // is the interface, and the provider-backed implementation really is async.
  moderate(input: ModerationInput): Promise<ModerationVerdict> {
    return Promise.resolve(this.check(input.text));
  }

  private check(text: string): ModerationVerdict {
    const haystack = normalise(text);

    for (const term of this.terms) {
      if (haystack.includes(normalise(term))) {
        // The reason names the category, not the user's text. Echoing back what
        // they typed would put the refused content into logs and into an API
        // response, which is the opposite of what a moderation decision is for.
        return { allowed: false, reason: `refused: ${term}`, source: this.name };
      }
    }

    return { allowed: true, source: this.name };
  }
}

/**
 * Lowercased, with every separator REMOVED rather than replaced by a space.
 *
 * Replacing punctuation with spaces looked right and defeated the point:
 * `D-o-x-x-i-n-g` normalised to `d o x x i n g`, which does not contain
 * `doxxing`, so the one obfuscation a person would actually try walked straight
 * through. Stripping the separators entirely makes the hyphenated spelling
 * collapse onto the plain one.
 *
 * The terms are long multi-word phrases, so removing spaces costs no precision:
 * there is no two-letter term here for `class` to match.
 */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface ModerationConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** The local rules always run; this is an ADDITIONAL check. */
  local?: LocalModerator;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * OpenAI's moderation response.
 *
 * `{flagged: true}` at the top level is NOT the shape the API returns, and
 * parsing for it means every real flag reads as clean. The first version of this
 * schema did exactly that: the unit test passed because it was fed the shape the
 * code expected rather than the shape the API sends.
 */
const moderationSchema = z.object({
  results: z
    .array(
      z.object({
        flagged: z.boolean(),
        category: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * A provider-backed moderator, run after the local rules.
 *
 * It never overrides a local refusal: a model is a heuristic, and a heuristic
 * that could undo a deterministic rule would make the rule decorative.
 */
export class ProviderModerator implements Moderator {
  readonly name = 'provider';

  constructor(private readonly config: ModerationConfig) {}

  async moderate(input: ModerationInput): Promise<ModerationVerdict> {
    const local = await (this.config.local ?? new LocalModerator()).moderate(input);

    if (!local.allowed) {
      return local;
    }

    if (this.config.apiKey === undefined || this.config.apiKey.trim() === '') {
      // Not an error: the local rules have already run and passed, and a
      // deployment with no moderation key must still be able to generate.
      return local;
    }

    const doFetch: FetchLike | undefined = this.config.fetchImpl ?? globalThis.fetch;

    if (doFetch === undefined) {
      return local;
    }

    try {
      const response = await doFetch(
        `${this.config.baseUrl ?? 'https://api.openai.com/v1'}/moderations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model ?? 'omni-moderation-latest',
            input: input.text,
          }),
        },
      );

      // A moderation service that is down must not silently allow everything,
      // and must not block every request either. Transient: the caller decides,
      // and the job has not been created yet so nothing is at risk.
      if (!response.ok) {
        throw new ProviderError(`moderation check failed (${response.status})`, 'TRANSIENT');
      }

      const parsed = moderationSchema.safeParse(await response.json());
      const result = parsed.success ? parsed.data : null;

      if (result?.results[0]?.flagged === true) {
        return {
          allowed: false,
          reason: `refused by provider moderation (${result.results[0]?.category ?? 'unspecified'})`,
          source: this.name,
        };
      }

      return { allowed: true, source: this.name };
    } catch (error) {
      throw new ProviderError(
        `moderation unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
        'TRANSIENT',
        { cause: error },
      );
    }
  }
}

export function createModerator(config: ModerationConfig = {}): Moderator {
  return new ProviderModerator(config);
}
