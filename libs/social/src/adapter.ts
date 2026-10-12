/**
 * Platform adapters (PROJECT.md section 12 Phase 7).
 *
 * Every platform is behind one interface with a deterministic mock, per
 * `AGENTS.md` section 8. The interface is shaped around what a publisher
 * actually has to guarantee rather than around what the APIs happen to expose,
 * because the guarantees are the part we own:
 *
 *  - `publish` must be safe to call twice. Every implementation checks its own
 *    idempotency before creating anything.
 *  - `findExternalPost` must answer "has this already gone out?" The publisher
 *    calls it before every attempt, and that call is what stops a worker killed
 *    after the platform accepted but before we recorded the id from publishing
 *    twice.
 *  - Errors are classified, not strings, because the caller decides between
 *    retrying, refreshing the token, and giving up.
 */

export type SocialPlatform = 'linkedin' | 'instagram';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ['linkedin', 'instagram'];

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/** Mirrors `ProviderError`: TRANSIENT is retried, PERMANENT is not. */
export type PublishErrorClass = 'TRANSIENT' | 'PERMANENT' | 'AUTH_EXPIRED' | 'REJECTED';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly classification: PublishErrorClass,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PublishError';
  }
}

export interface PublishRequest {
  /** Our own id for the publish job; the platform dedupes on it. */
  idempotencyKey: string;
  content: string;
  /** Storage key of the media, when the platform takes one. */
  mediaKey?: string | null;
  /** Platform-native container id, for carousels and multi-image posts. */
  containerId?: string | null;
}

export interface PublishResult {
  externalPostId: string;
  externalUrl: string | null;
  publishedAt: Date;
}

export interface SocialAdapter {
  readonly platform: SocialPlatform;
  /**
   * Creates the post.
   *
   * MUST be idempotent on `idempotencyKey`. Two calls with one key produce one
   * post and return the same id; that is the property the double-publish
   * guarantee rests on, and an implementation without it is a bug regardless of
   * what its documentation says.
   */
  publish(input: PublishRequest): Promise<PublishResult>;
  /**
   * What the platform already has for this idempotency key, if anything.
   *
   * Part of the interface, not an optional extra, because it is one of the
   * three checks the no-double-post guarantee rests on. On the interface it
   * cannot be forgotten by an implementation; as a duck-typed call it would be
   * found missing at the worst possible moment - after a platform accepted a
   * post and the worker died before recording the id.
   */
  findExternalPost(idempotencyKey: string): Promise<PublishResult | null>;
  /**
   * Whether this platform can carry a media file at all, and which kinds.
   * Instagram rejects a text-only post; saying so up front beats a 400 at
   * publish time, after the user has already been told it was scheduled.
   */
  readonly mediaPolicy: {
    acceptsTextOnly: boolean;
    acceptsVideo: boolean;
    acceptsImage: boolean;
    maxImageCount: number;
  };
  /** Token state, for the refresh path. */
  readonly tokenPolicy: { refreshable: boolean };
}

/**
 * Per-platform formatting (PROJECT.md section 12: "platform formatting rules").
 *
 * These run at SCHEDULE time, not at publish time. The reason is approval: a
 * user who approves text is approving the text as it will actually appear. If
 * the rules ran later, a post could be approved at 2999 characters and go out at
 * 2999 characters on LinkedIn and be silently cut to 2200 on Instagram, with no
 * record of why.
 */

export interface FormatResult {
  content: string;
  /** What the rules changed, so the UI can show it before approval. */
  notes: string[];
  /** False when the content had to be cut to fit. */
  fits: boolean;
}

interface PlatformRule {
  maxLength: number;
  /** The platform counts links as their expanded length; mirror that. */
  linkExpandsTo?: number;
}

const RULES: Record<SocialPlatform, PlatformRule> = {
  // LinkedIn's limit is 3000 characters.
  linkedin: { maxLength: 3_000 },
  // Instagram's caption limit is 2200.
  instagram: { maxLength: 2_200, linkExpandsTo: 23 },
};

/**
 * Formats post text for a platform.
 *
 * Hashtags are moved to the end rather than dropped: Instagram's first comment
 * convention does not apply to a caption, and truncating mid-taglist loses the
 * tags a brand depends on.
 */
export function formatForPlatform(
  platform: SocialPlatform,
  caption: string,
  hashtags: readonly string[] = [],
): FormatResult {
  const rule = RULES[platform];
  const notes: string[] = [];

  const cleanCaption = caption.trim();
  const tagText = hashtags
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .join(' ')
    .trim();

  let content = cleanCaption;

  if (tagText !== '') {
    const candidate = `${cleanCaption}\n\n${tagText}`;

    if (candidate.length <= rule.maxLength) {
      content = candidate;
    } else {
      // The caption wins and the tags are appended to what is left, so the
      // readable part is never the thing that gets cut.
      const room = rule.maxLength - cleanCaption.length - 2;
      const trimmedTags = fitTags(tagText, Math.max(0, room));

      notes.push(
        trimmedTags === ''
          ? 'hashtags dropped: no room in the caption limit'
          : 'hashtags shortened',
      );
      content = trimmedTags === '' ? cleanCaption : `${cleanCaption}\n\n${trimmedTags}`;
    }
  }

  if (content.length > rule.maxLength) {
    content = `${content.slice(0, rule.maxLength - 1).trimEnd()}…`;
    notes.push(`caption truncated to ${rule.maxLength} characters for ${platform}`);
  }

  return { content, notes, fits: content.length <= rule.maxLength };
}

/** Takes whole tags until the budget runs out, never half a tag. */
function fitTags(tagText: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }

  const kept: string[] = [];
  let length = 0;

  for (const tag of tagText.split(' ')) {
    const next = kept.length === 0 ? tag.length : length + 1 + tag.length;
    if (next > budget) {
      break;
    }
    kept.push(tag);
    length = next;
  }

  return kept.join(' ');
}

/** True when the post can go to this platform as it stands. */
export function canPublish(
  platform: SocialPlatform,
  result: FormatResult,
  hasMedia: boolean,
): { ok: boolean; reason?: string } {
  if (result.content.trim() === '' && !hasMedia) {
    return { ok: false, reason: 'a post needs text or media' };
  }

  if (!hasMedia && !RULE_ACCEPTS_TEXT_ONLY[platform]) {
    // Better caught here than as a 400 from the platform after the user was told
    // the post was scheduled.
    return { ok: false, reason: `${platform} requires media; this post has none` };
  }

  return { ok: true };
}

const RULE_ACCEPTS_TEXT_ONLY: Record<SocialPlatform, boolean> = {
  linkedin: true,
  instagram: false,
};
