import {
  ProviderError,
  providerDelay,
  type AudioResult,
  type BrandContext,
  type CaptionResult,
  type ContentPlan,
  type ImageResult,
  type RenderResult,
  type RendererProvider,
  type ScriptResult,
  type ImageProvider,
  type TextProvider,
  type TtsProvider,
} from './providers';

/**
 * Deterministic mock providers (AGENTS.md section 8: "Every interface has a Mock
 * implementation that is deterministic and fast. Local dev and CI use mocks by
 * default").
 *
 * Deterministic means the same input always produces the same output. That is
 * what lets a test assert on a specific caption or storage key rather than on a
 * shape, and it is why the text below is derived from the input rather than
 * random.
 *
 * Failure injection mirrors PROJECT.md section 13.4: `FAIL_STAGE` and `FAIL_RATE`
 * are read from the environment so the e2e "failure refunds credits" journey can
 * be driven from outside the code.
 */

export interface MockOptions {
  /** Simulated latency, so a test can observe intermediate progress. */
  latencyMs?: number;
  /** Stage name that should fail, e.g. `IMAGE`. */
  failStage?: string;
  /** 0..1 probability of a transient failure. Deterministic: see `sequence`. */
  failRate?: number;
  /**
   * Fail every nth call. Deterministic by construction, unlike `failRate` with a
   * random source - a random failure rate makes a suite flaky, which is worse
   * than no failure injection at all.
   */
  failEveryNth?: number;
  sequence?: { count: number };
}

function shouldFail(options: MockOptions): boolean {
  const seq = options.sequence;
  if (seq === undefined) {
    return false;
  }
  seq.count += 1;
  return options.failEveryNth !== undefined && seq.count % options.failEveryNth === 0;
}

/**
 * Reads injection settings from the environment.
 *
 * `FAIL_STAGE` is checked per call rather than at construction, so a test can
 * change it between stages.
 */
export function mockOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MockOptions {
  return {
    latencyMs: Number(env.MOCK_LATENCY_MS ?? 0) || 0,
    failStage: env.FAIL_STAGE,
    failRate: Number(env.FAIL_RATE ?? 0) || 0,
    failEveryNth: Number(env.FAIL_EVERY_NTH ?? 0) || undefined,
    sequence: { count: 0 },
  };
}

export class MockTextProvider implements TextProvider {
  readonly name = 'mock-text';

  constructor(private readonly options: MockOptions = {}) {}

  async plan(input: { goal: string; days: number; brand: BrandContext }): Promise<ContentPlan> {
    await providerDelay(this.options.latencyMs ?? 0);
    if (shouldFail(this.options)) {
      throw new ProviderError('mock text failure', 'TRANSIENT');
    }
    return {
      days: Array.from({ length: input.days }, (_, i) => ({
        day: i + 1,
        angle: `${input.goal} - day ${i + 1}`,
        notes: this.brandNotes(input.brand),
      })),
    };
  }

  async caption(input: { angle: string; brand: BrandContext }): Promise<CaptionResult> {
    await providerDelay(this.options.latencyMs ?? 0);
    if (shouldFail(this.options)) {
      throw new ProviderError('mock text failure', 'TRANSIENT');
    }
    return {
      caption: `${input.angle}. ${this.brandNotes(input.brand)}`,
      hashtags: this.hashtags(input.brand),
    };
  }

  async script(input: { caption: string; scenes: number }): Promise<ScriptResult> {
    await providerDelay(this.options.latencyMs ?? 0);
    if (shouldFail(this.options)) {
      throw new ProviderError('mock text failure', 'TRANSIENT');
    }
    return {
      scenes: Array.from({ length: input.scenes }, (_, i) => ({
        index: i + 1,
        narration: `${input.caption} (scene ${i + 1})`,
        durationMs: 3_000,
      })),
    };
  }

  private brandNotes(brand: BrandContext): string {
    const parts = [brand.name];
    if (brand.tone !== null && brand.tone !== undefined && brand.tone !== '') {
      parts.push(brand.tone);
    }
    if (brand.audience !== null && brand.audience !== undefined && brand.audience !== '') {
      parts.push(`for ${brand.audience}`);
    }
    return parts.join(' - ');
  }

  /** Derived from the brand name so the output is stable, not random. */
  private hashtags(brand: BrandContext): string[] {
    const slug = brand.name.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
    return [`#${slug}`, '#renderflow', ...brand.languages.map((l) => `#${l}`)];
  }
}

export class MockImageProvider implements ImageProvider {
  readonly name = 'mock-image';

  constructor(private readonly options: MockOptions = {}) {}

  async generate(input: {
    prompt: string;
    index: number;
    kind: string;
    width: number;
    height: number;
  }): Promise<ImageResult> {
    await providerDelay(this.options.latencyMs ?? 0);
    this.maybeFail('IMAGE');
    // Key is derived from the prompt and index so a retry writes the same object
    // rather than accumulating near-duplicates.
    const slug = input.prompt
      .slice(0, 32)
      .replace(/[^A-Za-z0-9]+/g, '-')
      .toLowerCase();
    return {
      storageKey: `generated/${input.kind}/${slug}-${input.index}.png`,
      width: input.width,
      height: input.height,
    };
  }

  private maybeFail(stage: string): void {
    if (this.options.failStage === stage) {
      throw new ProviderError(`mock failure at ${stage}`, 'TRANSIENT');
    }
    if (shouldFail(this.options)) {
      throw new ProviderError(`mock failure at ${stage}`, 'TRANSIENT');
    }
  }
}

export class MockTtsProvider implements TtsProvider {
  readonly name = 'mock-tts';

  constructor(private readonly options: MockOptions = {}) {}

  async speak(input: { text: string; voice: string }): Promise<AudioResult> {
    await providerDelay(this.options.latencyMs ?? 0);
    this.maybeFail('VOICE');
    const slug = input.text
      .slice(0, 24)
      .replace(/[^A-Za-z0-9]+/g, '-')
      .toLowerCase();
    return {
      storageKey: `generated/audio/${input.voice}/${slug}.mp3`,
      // Deterministic from the text length, so a test can assert a duration.
      durationMs: Math.max(500, input.text.length * 50),
    };
  }

  private maybeFail(stage: string): void {
    if (this.options.failStage === stage) {
      throw new ProviderError(`mock failure at ${stage}`, 'TRANSIENT');
    }
    if (shouldFail(this.options)) {
      throw new ProviderError(`mock failure at ${stage}`, 'TRANSIENT');
    }
  }
}

export class MockRendererProvider implements RendererProvider {
  readonly name = 'mock-renderer';

  constructor(private readonly options: MockOptions = {}) {}

  async render(input: {
    scenes: Array<{ imageKey: string; audioKey: string }>;
    width: number;
    height: number;
  }): Promise<RenderResult> {
    await providerDelay(this.options.latencyMs ?? 0);
    if (this.options.failStage === 'RENDER') {
      throw new ProviderError('mock failure at RENDER', 'TRANSIENT');
    }
    if (shouldFail(this.options)) {
      throw new ProviderError('mock failure at RENDER', 'TRANSIENT');
    }
    return {
      storageKey: `generated/video/render-${input.width}x${input.height}-${input.scenes.length}.mp4`,
      // A deterministic function of the input, not a timer.
      durationMs: input.scenes.length * 3_000,
    };
  }
}
