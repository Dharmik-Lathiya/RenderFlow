import { createProviders, requireKey, textPreference } from './factory';
import { aspectFor, hashOf, type MediaSink } from './media-providers';
import { ProviderError } from './providers';

/**
 * The provider factory, and the contract that makes the Phase 6 DoD meaningful.
 *
 * The DoD has two halves: real generation works with provider keys, and
 * "switching `AI_PROVIDER=mock` still passes the whole test suite". The second
 * is only true if mock and real are genuinely interchangeable, so what is
 * asserted here is that the factory returns the SAME INTERFACES either way and
 * that behaviour does not change - only which object is behind them.
 */

const sink: MediaSink = { put: async () => {} };

const rendererStorage = {
  getObject: async () => new Uint8Array(0),
  putObject: async () => ({}),
};

const baseOptions = { sink, rendererStorage };

describe('textPreference', () => {
  it('defaults to mock, with no chain', () => {
    expect(textPreference({})).toEqual(['mock']);
  });

  it('treats an unrecognised value as mock rather than failing at boot', () => {
    expect(textPreference({ AI_PROVIDER: 'gpt5-turbo' })).toEqual(['mock']);
  });

  it('appends the other vendor as a fallback', () => {
    expect(textPreference({ AI_PROVIDER: 'anthropic' })).toEqual(['anthropic', 'openai']);
    expect(textPreference({ AI_PROVIDER: 'openai' })).toEqual(['openai', 'anthropic']);
  });

  it('honours an explicit chain', () => {
    expect(textPreference({ TEXT_PROVIDER_FALLBACKS: 'openai,anthropic' })).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('drops names it does not recognise rather than building a broken chain', () => {
    expect(textPreference({ TEXT_PROVIDER_FALLBACKS: 'openai,bogus, anthropic ' })).toEqual([
      'openai',
      'anthropic',
    ]);
  });
});

describe('requireKey', () => {
  it('names the variable that is missing', () => {
    // Failing at boot with this sentence is the difference between a five-second
    // fix and a job that 500s on the first reel for an hour.
    expect(() => requireKey({}, 'OPENAI_API_KEY')).toThrow(/OPENAI_API_KEY is required/);
  });

  it('suggests the mock rather than leaving the reader guessing', () => {
    expect(() => requireKey({ OPENAI_API_KEY: '  ' }, 'OPENAI_API_KEY')).toThrow(
      /AI_PROVIDER=mock/,
    );
  });

  it('is not consulted at all in mock mode', () => {
    // The normal local setup has no keys and must keep working.
    expect(() => createProviders({ env: {}, ...baseOptions })).not.toThrow();
  });
});

describe('createProviders in mock mode', () => {
  const providers = createProviders({ env: {}, ...baseOptions });

  it('reports itself as fully mock', () => {
    // This flag is what the Phase 6 DoD leans on: if anything is not the mock,
    // "the suite passed with mocks" stops meaning anything.
    expect(providers.allMock).toBe(true);
  });

  it('produces the same interfaces either way', () => {
    expect(typeof providers.text.plan).toBe('function');
    expect(typeof providers.text.caption).toBe('function');
    expect(typeof providers.text.script).toBe('function');
    expect(typeof providers.image.generate).toBe('function');
    expect(typeof providers.tts.speak).toBe('function');
    expect(typeof providers.renderer.render).toBe('function');
  });

  it('uses the REAL renderer even in mock mode', () => {
    // It has no key, no network and no cost, and it is the component the user
    // actually sees. Mocking it would mean the reel a developer watches locally
    // is not the reel production produces.
    expect(providers.renderer.name).toBe('ffmpeg');
  });

  it('runs a caption end to end', async () => {
    const caption = await providers.text.caption({
      angle: 'the weather',
      brand: { name: 'Northwind', colors: [], languages: ['en'] },
    });

    expect(caption.caption).not.toHaveLength(0);
    expect(Array.isArray(caption.hashtags)).toBe(true);
  });

  it('runs a plan end to end', async () => {
    const plan = await providers.text.plan({
      goal: 'launch',
      days: 3,
      brand: { name: 'Northwind', colors: [], languages: ['en'] },
    });

    expect(plan.days).toHaveLength(3);
  });
});

describe('createProviders with real providers configured', () => {
  const env = {
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    OPENAI_API_KEY: 'sk-openai-test',
    IMAGE_PROVIDER: 'replicate',
    REPLICATE_API_TOKEN: 'replicate-test',
    TTS_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'eleven-test',
  };

  it('does not report itself as mock', () => {
    expect(createProviders({ env, ...baseOptions }).allMock).toBe(false);
  });

  it('names the chain it will walk', () => {
    expect(createProviders({ env, ...baseOptions }).text.name).toBe('chain:anthropic>openai');
  });

  it('still returns the same interface shapes', () => {
    const providers = createProviders({ env, ...baseOptions });

    expect(typeof providers.text.caption).toBe('function');
    expect(typeof providers.image.generate).toBe('function');
    expect(typeof providers.tts.speak).toBe('function');
  });

  it('mixing a mock text provider with real image generation is allowed', () => {
    // Separately billable and separately likely to be down. Forcing one variable
    // to control all three would make this combination impossible to express.
    const providers = createProviders({
      env: { ...env, IMAGE_PROVIDER: 'mock' },
      ...baseOptions,
    });

    expect(providers.text.name).toBe('chain:anthropic>openai');
    expect(providers.allMock).toBe(false);
  });

  it('refuses to start without the key it selected', () => {
    expect(() =>
      createProviders({ env: { ...env, REPLICATE_API_TOKEN: '' }, ...baseOptions }),
    ).toThrow(/REPLICATE_API_TOKEN/);
  });

  it('does not demand a key for a provider the chain may never reach', () => {
    // A deployment with one vendor key must still be able to fall back, which it
    // cannot do if the second provider is constructed - and its key demanded - up
    // front.
    expect(() =>
      createProviders({
        env: { ...env, OPENAI_API_KEY: '' },
        ...baseOptions,
      }),
    ).not.toThrow();
  });

  it('surfaces a real refusal through the chain without routing around it', async () => {
    // Anthropic refuses, OpenAI has no key at all: the chain must surface the
    // refusal as a PERMANENT error rather than trying to "fix" it elsewhere.
    const providers = createProviders({
      env: { ...env, OPENAI_API_KEY: '' },
      fetchImpl: async () =>
        ({
          ok: false,
          status: 400,
          text: async () => 'content refused',
          json: async () => ({}),
        }) as unknown as Response,
      ...baseOptions,
    });

    await expect(
      providers.text.caption({
        angle: 'x',
        brand: { name: 'B', colors: [], languages: ['en'] },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('reaches the second provider when the first is simply down', async () => {
    let calls = 0;
    const providers = createProviders({
      env: { ...env, AI_PROVIDER: 'openai', TEXT_PROVIDER_FALLBACKS: 'openai,anthropic' },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? ({
              ok: false,
              status: 503,
              text: async () => 'upstream down',
              json: async () => ({}),
            } as unknown as Response)
          : ({
              ok: true,
              status: 200,
              json: async () => ({
                choices: [{ message: { content: '{"caption":"Fallback worked.","hashtags":[]}' } }],
              }),
              text: async () => '',
            } as unknown as Response);
      },
      ...baseOptions,
    });

    const caption = await providers.text.caption({
      angle: 'x',
      brand: { name: 'B', colors: [], languages: ['en'] },
    });

    expect(caption.caption).toBe('Fallback worked.');
    expect(calls).toBe(2);
  });
});

describe('aspectFor', () => {
  it('maps the ratios a reel actually uses', () => {
    expect(aspectFor(1920, 1080)).toBe('16:9');
    expect(aspectFor(1080, 1080)).toBe('1:1');
    expect(aspectFor(1080, 1350)).toBe('4:5');
    expect(aspectFor(1080, 1920)).toBe('9:16');
  });

  it('does not crash on a zero or negative height', () => {
    // A bad dimension from a caller must produce a ratio, not a NaN that
    // becomes a model parameter.
    expect(aspectFor(1080, 0)).toBe('16:9');
  });
});

describe('hashOf', () => {
  it('is stable for the same text, so a retry reuses the object', () => {
    expect(hashOf('hello')).toBe(hashOf('hello'));
  });

  it('differs for different text', () => {
    expect(hashOf('hello')).not.toBe(hashOf('goodbye'));
  });

  it('is a fixed width, so storage keys sort sensibly', () => {
    expect(hashOf('')).toHaveLength(8);
    expect(hashOf('x')).toHaveLength(8);
  });
});
