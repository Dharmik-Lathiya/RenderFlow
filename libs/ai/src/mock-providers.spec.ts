import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  ProviderError,
  mockOptionsFromEnv,
  type BrandContext,
  type ImageProvider,
  type RendererProvider,
  type TextProvider,
  type TtsProvider,
} from './index';
import { STAGE_FOR_KIND } from './providers';
import { FESTIVAL_TEMPLATE_SEEDS } from '@renderflow/common';

/**
 * Determinism of the mock providers.
 *
 * These tests exist because the mocks' whole value is that a test can assert on
 * specific output. If a mock ever became non-deterministic, every test using it
 * would become flaky, which is a worse failure than having no mock at all - so
 * the property is pinned here.
 */
const BRAND: BrandContext = {
  name: 'Northwind Coffee',
  industry: 'retail',
  tone: 'friendly and direct',
  audience: 'urban commuters',
  colors: ['#112233'],
  languages: ['en', 'pt-BR'],
};

describe('MockTextProvider', () => {
  const provider = (): TextProvider => new MockTextProvider();

  it('produces the same caption for the same input', async () => {
    const input = { angle: 'Launch day', brand: BRAND };
    const [first, second] = await Promise.all([
      provider().caption(input),
      provider().caption(input),
    ]);

    expect(first).toEqual(second);
  });

  it('reflects the brand voice in the caption', async () => {
    const result = await provider().caption({ angle: 'Launch day', brand: BRAND });

    expect(result.caption).toContain('friendly and direct');
    expect(result.caption).toContain('urban commuters');
  });

  it('derives hashtags from the brand rather than inventing them', async () => {
    const result = await provider().caption({ angle: 'Launch day', brand: BRAND });

    // A hash of the brand name means the same brand always produces the same tag,
    // so a test can assert on it.
    expect(result.hashtags).toContain('#northwindcoffee');
    expect(result.hashtags).toContain('#en');
    // Language tags keep their casing: BCP-47 is case-sensitive after the
    // primary subtag, so `#pt-BR` is the correct tag.
    expect(result.hashtags).toContain('#pt-BR');
  });

  it('returns exactly the requested number of plan days', async () => {
    const plan = await provider().plan({ goal: 'spring launch', days: 7, brand: BRAND });

    expect(plan.days).toHaveLength(7);
    expect(plan.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns exactly the requested number of scenes', async () => {
    const script = await provider().script({ caption: 'A reel', scenes: 5 });

    expect(script.scenes).toHaveLength(5);
    expect(script.scenes[0]).toMatchObject({ index: 1, durationMs: 3_000 });
  });

  it('reports a name, so logs can say which provider ran', () => {
    expect(provider().name).toBe('mock-text');
  });

  it('fills every text slot of a festival template deterministically', async () => {
    const template = FESTIVAL_TEMPLATE_SEEDS[0];
    if (template === undefined) {
      throw new Error('no seeded template');
    }

    const input = {
      occasionId: 'DIWALI',
      occasionName: 'Diwali',
      template,
      offerText: '20% off',
      ctaText: 'Order now',
      language: 'both' as const,
      brand: BRAND,
    };

    const first = await provider().festivalCopy(input);
    const second = await provider().festivalCopy(input);

    expect(first).toEqual(second);
    for (const slot of template.slots.filter((row) => row.type === 'text')) {
      expect(first.slots[slot.id]).toBeDefined();
      expect(first.slots[slot.id]?.length ?? Infinity).toBeLessThanOrEqual(slot.maxChars ?? 80);
    }
    expect(first.slots.offer).toBe('20% off');
    expect(first.slots.cta).toBe('Order now');
    expect(first.hashtags).toContain('#diwali');
  });
});

describe('MockImageProvider', () => {
  it('derives the storage key from the prompt and index', async () => {
    const provider: ImageProvider = new MockImageProvider();
    const input = {
      prompt: 'A busy café',
      index: 2,
      kind: 'POSTER' as const,
      width: 1080,
      height: 1080,
    };

    const result = await provider.generate(input);

    // Deterministic key means a retry overwrites rather than accumulating
    // near-duplicate objects. The slug keeps the hyphen that `café` collapses
    // into, which is harmless in an object key and keeps the rule simple.
    expect(result.storageKey).toBe('generated/POSTER/a-busy-caf--2.png');
    await expect(provider.generate(input)).resolves.toEqual(result);
  });

  it('gives different scenes different keys', async () => {
    const provider = new MockImageProvider();
    const base = { prompt: 'Scene', kind: 'REEL', width: 1080, height: 1920 };

    const one = await provider.generate({ ...base, index: 1 });
    const two = await provider.generate({ ...base, index: 2 });

    expect(one.storageKey).not.toBe(two.storageKey);
  });
});

describe('MockTtsProvider', () => {
  it('derives duration from the text rather than a timer', async () => {
    const provider: TtsProvider = new MockTtsProvider();

    const result = await provider.speak({ text: 'Hello there', voice: 'en-GB' });

    // A timer would make this untestable; a pure function of the input would not.
    expect(result.durationMs).toBe(Math.max(500, 'Hello there'.length * 50));
  });
});
describe('MockRendererProvider', () => {
  const provider: RendererProvider = new MockRendererProvider();

  it('scales the duration with the scene count', async () => {
    const scenes = [
      { imageKey: 'a.png', audioKey: 'a.mp3' },
      { imageKey: 'b.png', audioKey: 'b.mp3' },
    ];

    const result = await provider.render({ scenes, width: 1080, height: 1920 });

    expect(result.durationMs).toBe(6_000);
    expect(result.storageKey).toContain('1080x1920');
  });

  it('renders festival posters and reels to job-scoped keys', async () => {
    const input = {
      jobId: 'job-1',
      width: 1080,
      height: 1080,
      background: '#101828',
      primary: '#6366f1',
      accent: '#f59e0b',
      lines: [{ text: 'Diwali', fontSize: 64, position: 'top-center' as const }],
    };

    const poster = await provider.renderFestivalPoster(input);
    expect(poster.storageKey).toBe('generated/festival/job-1/poster-1080x1080.png');

    const reel = await provider.renderFestivalReel({
      ...input,
      posterKey: poster.storageKey,
      audioKey: null,
      durationMs: 15_000,
      brandName: 'Northwind',
    });
    expect(reel).toMatchObject({
      storageKey: 'generated/festival/job-1/reel-1080x1080.mp4',
      durationMs: 15_000,
    });
  });
});

describe('failure injection', () => {
  it('fails at an explicitly named stage', async () => {
    const images = new MockImageProvider({ failStage: 'IMAGE' });

    await expect(
      images.generate({ prompt: 'x', index: 1, kind: 'REEL', width: 1, height: 1 }),
    ).rejects.toMatchObject({ classification: 'TRANSIENT' });
  });

  it('does not fail at a different stage than the one named', async () => {
    const tts = new MockTtsProvider({ failStage: 'IMAGE' });

    await expect(tts.speak({ text: 'ok', voice: 'en' })).resolves.toBeDefined();
  });

  it('fails every nth call rather than at random', async () => {
    // A random failure rate would make the suite flaky. This is deterministic by
    // construction: calls 2, 4, 6 fail.
    const images = new MockImageProvider({ failEveryNth: 2, sequence: { count: 0 } });

    const results: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await images
        .generate({ prompt: 'x', index: i, kind: 'REEL', width: 1, height: 1 })
        .then(() => 'ok')
        .catch(() => 'failed');
      results.push(outcome);
    }

    expect(results).toEqual(['ok', 'failed', 'ok', 'failed']);
  });

  it('never fails when no injection is configured', async () => {
    const images = new MockImageProvider();

    for (let i = 0; i < 20; i += 1) {
      await expect(
        images.generate({ prompt: 'x', index: i, kind: 'REEL', width: 1, height: 1 }),
      ).resolves.toBeDefined();
    }
  });
});

describe('mockOptionsFromEnv', () => {
  it('reads the documented injection variables', () => {
    const options = mockOptionsFromEnv({
      MOCK_LATENCY_MS: '5',
      FAIL_STAGE: 'IMAGE',
      FAIL_EVERY_NTH: '3',
    });

    expect(options).toMatchObject({
      latencyMs: 5,
      failStage: 'IMAGE',
      failEveryNth: 3,
    });
  });

  it('defaults to no latency and no failures', () => {
    // A mock that fails unpredictably by default would be worse than none.
    const options = mockOptionsFromEnv({});

    expect(options.latencyMs).toBe(0);
    expect(options.failStage).toBeUndefined();
    expect(options.failEveryNth).toBeUndefined();
  });

  it('gives each call site its own counter', () => {
    const a = mockOptionsFromEnv({});
    const b = mockOptionsFromEnv({});

    expect(a.sequence).not.toBe(b.sequence);
  });
});

describe('STAGE_FOR_KIND', () => {
  it('maps every generation kind to a starting stage', () => {
    // The runner uses this to decide where a job begins; a missing entry would
    // silently produce a job with no stage.
    for (const kind of [
      'CONTENT_PLAN',
      'CAPTION',
      'POSTER',
      'CAROUSEL',
      'REEL',
      'REGENERATE_SCENE',
      'TRANSLATION',
      'FESTIVAL_IMAGE',
      'FESTIVAL_REEL',
    ] as const) {
      expect(STAGE_FOR_KIND[kind]).toBeDefined();
    }
  });

  it('starts a reel at VOICE, since the script and images precede it', () => {
    expect(STAGE_FOR_KIND.REEL).toBe('VOICE');
  });
});

describe('ProviderError', () => {
  it('carries a classification the runner can branch on', () => {
    // Retry or refund is the whole point of classifying.
    expect(new ProviderError('boom', 'TRANSIENT')).toMatchObject({
      name: 'ProviderError',
      classification: 'TRANSIENT',
    });
    expect(new ProviderError('boom', 'PERMANENT').classification).toBe('PERMANENT');
  });
});
