import { z } from 'zod';

import { PublishError, type SocialPlatform } from './adapter';

/**
 * Platform metrics (PROJECT.md sections 6 and 12 Phase 9).
 *
 * The analytics worker pulls these; the API reads them from `post_metrics`.
 * Behind an interface with a deterministic mock for the same reason as the
 * publisher: CI must never call a real platform (AGENTS.md section 8), and a
 * test that depends on Instagram's numbers is a test that fails for reasons
 * unrelated to this code.
 */

export interface PlatformMetrics {
  likes: number;
  comments: number;
  reach: number;
  clicks: number;
}

export interface FetchMetricsInput {
  /** The platform's id, recorded by the publisher. */
  externalPostId: string;
  /** Decrypted at the edge; never logged. */
  accessToken: string;
  /**
   * The snapshot bucket, not "now".
   *
   * The sync passes the hour it is writing, so two runs in one hour ask the
   * mock for the same answer and the upsert cannot flap.
   */
  at: Date;
  /** When the post went live, when known. Lets a mock model growth. */
  publishedAt?: Date | null;
}

export interface MetricsAdapter {
  readonly platform: SocialPlatform;
  /**
   * False when the platform exposes no metrics through the API surface we have.
   *
   * A value on the interface rather than a thrown error: "this platform has no
   * metrics" is a stable fact about the platform, not a failure of this call,
   * and the worker should log it once rather than retry it forever.
   */
  readonly supported: boolean;
  fetchMetrics(input: FetchMetricsInput): Promise<PlatformMetrics>;
}

/**
 * Deterministic mock (AGENTS.md section 8).
 *
 * The numbers grow with the post's age, because a flat constant would let a
 * dashboard bug - "always show the first snapshot" - pass every test. They are
 * derived from the post id so two different posts do not report identical
 * engagement, which would hide an accidental cross-post join.
 */
export class MockMetricsAdapter implements MetricsAdapter {
  readonly platform: SocialPlatform;

  readonly supported = true;

  private failuresRemaining: number;

  constructor(
    private readonly options: {
      platform: SocialPlatform;
      /** Fails this many calls, for the retry path. */
      failTimes?: number;
      failWith?: PublishError['classification'];
    },
  ) {
    this.platform = options.platform;
    this.failuresRemaining = options.failTimes ?? 0;
  }

  fetchMetrics(input: FetchMetricsInput): Promise<PlatformMetrics> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(
        new PublishError(
          `${this.platform} metrics are temporarily unavailable`,
          this.options.failWith ?? 'TRANSIENT',
          500,
        ),
      );
    }

    const seed = hash(`${this.platform}:${input.externalPostId}`);
    const publishedAt = input.publishedAt ?? new Date(0);
    // At least one hour: a post published a minute ago has still been seen by
    // somebody, and zeroes look like a broken query in a test assertion.
    const ageHours = Math.max(
      1,
      Math.floor((input.at.getTime() - publishedAt.getTime()) / 3_600_000),
    );

    const likes = (seed % 40) + ageHours * (1 + (seed % 5));
    const comments = Math.floor(likes * 0.08) + (seed % 3);
    // LinkedIn reports impressions; Instagram reports reach. Same column.
    const reach = likes * (5 + (seed % 4)) + 50 + ageHours * 2;
    const clicks = Math.floor(reach * 0.02) + (seed % 5);

    return Promise.resolve({ likes, comments, reach, clicks });
  }
}

/** A platform we publish to but cannot read numbers from. */
export class UnsupportedMetricsAdapter implements MetricsAdapter {
  readonly supported = false;

  constructor(readonly platform: SocialPlatform) {}

  fetchMetrics(): Promise<PlatformMetrics> {
    return Promise.reject(
      new PublishError(`${this.platform} exposes no metrics through this integration`, 'PERMANENT'),
    );
  }
}

const insightSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.object({ value: z.number().finite() })).min(1),
    }),
  ),
});

/**
 * Instagram Graph API.
 *
 * `likes`, `comments` and `reach` are the three metrics that are available for
 * every media type. Instagram does not expose click counts for organic posts,
 * so `clicks` is zero rather than guessed: a fabricated number in a dashboard is
 * worse than an honest blank.
 *
 * `fetchImpl` is injectable so the request shape is tested against a stub, with
 * no network and no token (AGENTS.md section 9).
 */
export class InstagramMetricsAdapter implements MetricsAdapter {
  readonly platform = 'instagram';

  readonly supported = true;

  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      baseUrl?: string;
      apiVersion?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async fetchMetrics(input: FetchMetricsInput): Promise<PlatformMetrics> {
    const baseUrl = this.options.baseUrl ?? 'https://graph.facebook.com';
    const apiVersion = this.options.apiVersion ?? 'v21.0';
    const url = new URL(
      `${baseUrl}/${apiVersion}/${encodeURIComponent(input.externalPostId)}/insights`,
    );

    url.searchParams.set('metric', 'likes,comments,reach');
    // In the query string because that is the Graph API's contract. It is never
    // logged: the worker logs the post id and the outcome, not the URL.
    url.searchParams.set('access_token', input.accessToken);

    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      // A timeout or a socket error is transient by definition: the post is
      // still there, and the next sync will ask again.
      throw new PublishError(
        `instagram metrics request failed: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSIENT',
        undefined,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw classifyHttpFailure(response.status);
    }

    const parsed = insightSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new PublishError(
        `instagram returned an unexpected insights payload: ${parsed.error.issues[0]?.message ?? 'invalid shape'}`,
        'PERMANENT',
      );
    }

    const value = (name: string): number =>
      parsed.data.data.find((metric) => metric.name === name)?.values[0]?.value ?? 0;

    return {
      likes: Math.trunc(value('likes')),
      comments: Math.trunc(value('comments')),
      reach: Math.trunc(value('reach')),
      clicks: 0,
    };
  }
}

function classifyHttpFailure(status: number): PublishError {
  if (status === 401 || status === 403) {
    return new PublishError(`instagram rejected the access token (HTTP ${status})`, 'AUTH_EXPIRED');
  }

  if (status === 429) {
    return new PublishError('instagram rate limit reached', 'TRANSIENT', 60_000);
  }

  if (status >= 500) {
    return new PublishError(`instagram is unavailable (HTTP ${status})`, 'TRANSIENT');
  }

  // A 400/404 for a post we believe exists is not going to fix itself; retrying
  // only burns the queue. The sync records it and moves on.
  return new PublishError(`instagram refused the metrics request (HTTP ${status})`, 'PERMANENT');
}

/**
 * Selects an adapter. Mocks unless the environment explicitly opts into real
 * platforms, matching the publisher's rule (AGENTS.md section 8).
 */
export function metricsAdapterFor(
  platform: SocialPlatform,
  options: { mock?: boolean; fetchImpl?: typeof fetch } = {},
): MetricsAdapter {
  if (options.mock !== false) {
    return new MockMetricsAdapter({ platform });
  }

  if (platform === 'instagram') {
    return new InstagramMetricsAdapter({ fetchImpl: options.fetchImpl });
  }

  // LinkedIn's share statistics need the organization URN and the share URN,
  // neither of which the publisher records today. Reporting "unsupported" is
  // honest; inventing a number from the post id would be worse than no panel.
  return new UnsupportedMetricsAdapter(platform);
}

function hash(text: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}
