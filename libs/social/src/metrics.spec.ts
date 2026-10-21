import { MockMetricsAdapter, UnsupportedMetricsAdapter, metricsAdapterFor } from './metrics';
import { InstagramMetricsAdapter } from './metrics';
import { PublishError } from './adapter';

/**
 * Metrics adapters (PROJECT.md Phase 9).
 *
 * The mock is asserted to be DETERMINISTIC and to grow with age, because a flat
 * constant would let "always show the first snapshot" pass every dashboard test.
 * The real adapter is tested against a stub fetch: its request shape, its
 * parsing, and - the part that decides whether a queue retries forever - its
 * error classification.
 */

const NOW = new Date('2026-05-01T12:34:56Z');
const PUBLISHED = new Date('2026-05-01T09:00:00Z');

function input(overrides: Partial<Parameters<MockMetricsAdapter['fetchMetrics']>[0]> = {}) {
  return {
    externalPostId: 'post-1',
    accessToken: 'secret-token',
    at: NOW,
    publishedAt: PUBLISHED,
    ...overrides,
  };
}

describe('MockMetricsAdapter', () => {
  it('returns the same numbers for the same post and the same snapshot bucket', async () => {
    const adapter = new MockMetricsAdapter({ platform: 'instagram' });

    const first = await adapter.fetchMetrics(input());
    const second = await adapter.fetchMetrics(input());

    expect(second).toEqual(first);
  });

  it('grows with the post age', async () => {
    const adapter = new MockMetricsAdapter({ platform: 'instagram' });

    const young = await adapter.fetchMetrics(input({ at: new Date('2026-05-01T10:00:00Z') }));
    const old = await adapter.fetchMetrics(input({ at: new Date('2026-05-08T10:00:00Z') }));

    expect(old.likes).toBeGreaterThan(young.likes);
    expect(old.reach).toBeGreaterThan(young.reach);
  });

  it('does not report identical engagement for different posts', async () => {
    // A cross-post join bug would look plausible if every post had the same
    // numbers, so the mock derives them from the id.
    const adapter = new MockMetricsAdapter({ platform: 'instagram' });

    const first = await adapter.fetchMetrics(input({ externalPostId: 'post-1' }));
    const second = await adapter.fetchMetrics(input({ externalPostId: 'post-2' }));

    expect(second).not.toEqual(first);
  });

  it('can be told to fail, for the retry path', async () => {
    const adapter = new MockMetricsAdapter({ platform: 'instagram', failTimes: 1 });

    await expect(adapter.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
    await expect(adapter.fetchMetrics(input())).resolves.toMatchObject({
      likes: expect.any(Number),
    });
  });
});

describe('InstagramMetricsAdapter', () => {
  const payload = {
    data: [
      { name: 'likes', values: [{ value: 12 }] },
      { name: 'comments', values: [{ value: 3 }] },
      { name: 'reach', values: [{ value: 400 }] },
    ],
  };

  function adapterReturning(response: Response | Error) {
    const fetchImpl = jest.fn(async (_url: URL) => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });

    return {
      fetchImpl,
      adapter: new InstagramMetricsAdapter({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    };
  }

  it('requests likes, comments and reach for the external post id', async () => {
    const { adapter, fetchImpl } = adapterReturning(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    const metrics = await adapter.fetchMetrics(input());

    expect(metrics).toEqual({ likes: 12, comments: 3, reach: 400, clicks: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v21.0/post-1/insights');
    expect(url.searchParams.get('metric')).toBe('likes,comments,reach');
    expect(url.searchParams.get('access_token')).toBe('secret-token');
  });

  it('treats a rejected token as AUTH_EXPIRED, not transient', async () => {
    const { adapter } = adapterReturning(new Response('{}', { status: 401 }));

    await expect(adapter.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'AUTH_EXPIRED',
    });
  });

  it('retries a rate limit and a platform outage', async () => {
    const limited = adapterReturning(new Response('{}', { status: 429 })).adapter;
    const outage = adapterReturning(new Response('{}', { status: 503 })).adapter;

    await expect(limited.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'TRANSIENT',
      retryAfterMs: 60_000,
    });
    await expect(outage.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });

  it('does not retry a request the platform refused', async () => {
    const { adapter } = adapterReturning(new Response('{}', { status: 400 }));

    await expect(adapter.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'PERMANENT',
    });
  });

  it('fails permanently on an unexpected payload rather than publishing zeroes', async () => {
    const { adapter } = adapterReturning(
      new Response(JSON.stringify({ data: [{ nope: true }] }), { status: 200 }),
    );

    // A single call: the response body is consumed once, so asserting twice on
    // the same adapter would fail with a TypeError and hide the classification.
    await expect(adapter.fetchMetrics(input())).rejects.toMatchObject({
      name: 'PublishError',
      classification: 'PERMANENT',
    });
  });

  it('treats a network failure as transient', async () => {
    const { adapter } = adapterReturning(new Error('socket hang up'));

    await expect(adapter.fetchMetrics(input())).rejects.toMatchObject({
      classification: 'TRANSIENT',
    });
  });
});

describe('metricsAdapterFor', () => {
  it('defaults to the mock, so no test or dev run touches a platform', () => {
    expect(metricsAdapterFor('instagram')).toBeInstanceOf(MockMetricsAdapter);
  });

  it('returns the real adapter only when asked', () => {
    expect(metricsAdapterFor('instagram', { mock: false })).toBeInstanceOf(InstagramMetricsAdapter);
  });

  it('reports LinkedIn as unsupported instead of inventing numbers', async () => {
    const adapter = metricsAdapterFor('linkedin', { mock: false });

    expect(adapter).toBeInstanceOf(UnsupportedMetricsAdapter);
    expect(adapter.supported).toBe(false);
    await expect(adapter.fetchMetrics(input())).rejects.toBeInstanceOf(PublishError);
  });
});
