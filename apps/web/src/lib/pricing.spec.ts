import { describeAction, fetchPricing } from './pricing';

/**
 * The pricing page is only as honest as this fetch.
 *
 * Three rules are asserted here: a valid response is parsed, a malformed one is
 * refused rather than rendered, and a failed request returns `null` so the page
 * can say "unavailable" instead of showing a stale or invented number.
 */
describe('fetchPricing', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Accepts a response shape or a rejecting thunk; the cast lives here only. */
  function stubFetch(response: unknown): void {
    const impl = typeof response === 'function' ? response : () => Promise.resolve(response);
    global.fetch = impl as typeof fetch;
  }

  it('parses the API shape', async () => {
    stubFetch({
      ok: true,
      json: () =>
        Promise.resolve({
          signupBonus: 50,
          prices: [
            { action: 'CAPTION', credits: 1 },
            { action: 'REEL', credits: 30 },
          ],
        }),
    });

    await expect(fetchPricing()).resolves.toEqual({
      signupBonus: 50,
      prices: [
        { action: 'CAPTION', credits: 1 },
        { action: 'REEL', credits: 30 },
      ],
    });
  });

  it('returns null on a non-2xx response', async () => {
    stubFetch({ ok: false, json: () => Promise.resolve({}) });
    await expect(fetchPricing()).resolves.toBeNull();
  });

  it('returns null when the document is not the shape it claims', async () => {
    // A 200 with the wrong body is the case that would otherwise render
    // "undefined credits" on a public page.
    stubFetch({
      ok: true,
      json: () => Promise.resolve({ signupBonus: 'many', prices: 'lots' }),
    });

    await expect(fetchPricing()).resolves.toBeNull();
  });

  it('drops individual malformed prices rather than failing the page', async () => {
    stubFetch({
      ok: true,
      json: () =>
        Promise.resolve({
          signupBonus: 50,
          prices: [
            { action: 'CAPTION', credits: 1 },
            { action: 'BROKEN', credits: 1.5 },
            { nope: true },
          ],
        }),
    });

    await expect(fetchPricing()).resolves.toEqual({
      signupBonus: 50,
      prices: [{ action: 'CAPTION', credits: 1 }],
    });
  });

  it('returns null instead of throwing when the API is unreachable', async () => {
    stubFetch(() => Promise.reject(new Error('connect ECONNREFUSED')));

    await expect(fetchPricing()).resolves.toBeNull();
  });
});

describe('describeAction', () => {
  it('labels every kind the pipeline prices', () => {
    for (const action of ['CONTENT_PLAN', 'CAPTION', 'POSTER', 'CAROUSEL', 'REEL']) {
      expect(describeAction(action).label).not.toBe(action);
    }
  });

  it('falls back to the raw kind so a new action never renders blank', () => {
    expect(describeAction('SOMETHING_NEW')).toEqual({ label: 'SOMETHING_NEW' });
  });
});
