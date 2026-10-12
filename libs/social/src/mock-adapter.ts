import {
  PublishError,
  type PublishRequest,
  type PublishResult,
  type SocialAdapter,
  type SocialPlatform,
} from './adapter';

/**
 * The deterministic mock adapter (AGENTS.md section 8).
 *
 * It is not a stub that returns a constant. It MODELS the two behaviours the
 * publisher's correctness depends on, because a fake that returns a fresh id
 * every call cannot demonstrate either of them:
 *
 *  - **Idempotency.** The same key returns the same external id and does not
 *    create a second post. That is what lets the test suite prove a killed
 *    publisher does not double-post.
 *  - **Token expiry.** A token marked expired makes `publish` fail with
 *    `AUTH_EXPIRED`, which is the condition the refresh path exists to handle.
 */

export interface MockPlatformOptions {
  platform: SocialPlatform;
  /** Fails every publish with this class, for the retry path. */
  failWith?: PublishError['classification'];
  failTimes?: number;
  /** Makes the stored token read as expired. */
  tokenExpired?: boolean;
  /** Counts calls so a test can assert that a duplicate was refused. */
  calls?: { publish: number; find: number };
}

export class MockSocialAdapter implements SocialAdapter {
  readonly platform: SocialPlatform;

  readonly mediaPolicy: SocialAdapter['mediaPolicy'];

  readonly tokenPolicy = { refreshable: true };

  /**
   * The external posts this adapter believes exist.
   *
   * Held on the instance rather than module-level so each test gets its own
   * world: a shared map makes every test's duplicate detection depend on the
   * order the tests ran in.
   */
  private readonly published = new Map<string, PublishResult>();
  private failuresRemaining: number;

  constructor(private readonly options: MockPlatformOptions) {
    this.platform = options.platform;
    this.failuresRemaining = options.failTimes ?? 0;

    // Assigned rather than initialised inline: the field initialiser would run
    // before `platform` is set, and `this.platform === 'linkedin'` would read
    // undefined and quietly pick the Instagram policy for both.
    this.mediaPolicy =
      options.platform === 'linkedin'
        ? { acceptsTextOnly: true, acceptsVideo: true, acceptsImage: true, maxImageCount: 9 }
        : { acceptsTextOnly: false, acceptsVideo: true, acceptsImage: true, maxImageCount: 10 };
  }

  publish(input: PublishRequest): Promise<PublishResult> {
    // Synchronous by nature; a Promise because a real adapter is one. A throw
    // here surfaces as a rejected promise, which is what the publisher expects.
    try {
      return Promise.resolve(this.attempt(input));
    } catch (error) {
      // Everything thrown here is a PublishError; the guard is so a future edit
      // cannot start rejecting with a bare string, which the publisher would then
      // classify as unrecognised and treat as transient.
      return Promise.reject(
        error instanceof Error ? error : new PublishError(String(error), 'TRANSIENT'),
      );
    }
  }

  private attempt(input: PublishRequest): PublishResult {
    this.count('publish');

    // Idempotency BEFORE anything else, including the failure path: a retry after
    // a transient error must be able to succeed, and a retry after success must
    // return the original post rather than creating a second one.
    const existing = this.published.get(input.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    if (this.options.tokenExpired === true) {
      throw new PublishError('the access token has expired', 'AUTH_EXPIRED');
    }

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new PublishError(
        `${this.platform} rejected the post`,
        this.options.failWith ?? 'TRANSIENT',
        500,
      );
    }

    if (input.content.trim() === '' && (input.mediaKey === undefined || input.mediaKey === null)) {
      throw new PublishError('empty post', 'REJECTED');
    }

    if (
      !this.mediaPolicy.acceptsTextOnly &&
      (input.mediaKey === undefined || input.mediaKey === null)
    ) {
      throw new PublishError(`${this.platform} requires media`, 'REJECTED');
    }

    // Deterministic from the key, so a replayed call that somehow missed the map
    // still produces the same id rather than a second post under a new one.
    const result: PublishResult = {
      externalPostId: `${this.platform}-${hash(input.idempotencyKey)}`,
      externalUrl: `https://${this.platform}.example/post/${hash(input.idempotencyKey)}`,
      publishedAt: new Date(0),
    };

    this.published.set(input.idempotencyKey, result);
    return result;
  }

  /**
   * What the platform already has for our key.
   *
   * The publisher calls this BEFORE every publish attempt. It is the check that
   * survives a worker dying after the platform accepted the post but before we
   * wrote the id down.
   */
  findExternalPost(idempotencyKey: string): Promise<PublishResult | null> {
    this.count('find');
    return Promise.resolve(this.published.get(idempotencyKey) ?? null);
  }

  /** Everything this adapter believes it has published. For assertions. */
  posts(): PublishResult[] {
    return [...this.published.values()];
  }

  private count(which: 'publish' | 'find'): void {
    if (this.options.calls !== undefined) {
      this.options.calls[which] += 1;
    }
  }
}

function hash(text: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return (value >>> 0).toString(16);
}
