import { JOB_STAGES, type GenerationKind, type JobStage } from '@renderflow/common';

/**
 * AI provider interfaces (AGENTS.md section 8).
 *
 * Every provider sits behind an interface with a deterministic mock, and CI
 * never calls a real one. The reason is not only cost: a test that depends on a
 * language model's output is a test that fails for reasons unrelated to the code,
 * and one that depends on image generation is a test that takes minutes.
 *
 * Errors are classified, not thrown as strings, because the caller decides between
 * retrying and refunding. `TRANSIENT` means "try again"; `PERMANENT` means "stop
 * and give the credits back" (PROJECT.md section 5.1 rule 7).
 */

export type ErrorClassification = 'TRANSIENT' | 'PERMANENT';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly classification: ErrorClassification,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/** Marks a provider call as intentionally slow, so tests can assert on progress. */
export function providerDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted', 'TRANSIENT'));
      },
      { once: true },
    );
  });
}

export interface ContentPlan {
  days: Array<{ day: number; angle: string; notes: string }>;
}

export interface CaptionResult {
  caption: string;
  hashtags: string[];
}

export interface ScriptScene {
  index: number;
  narration: string;
  /** Seconds on screen. */
  durationMs: number;
}

export interface ScriptResult {
  scenes: ScriptScene[];
}

export interface ImageResult {
  /** Storage key of the written object. */
  storageKey: string;
  width: number;
  height: number;
}

export interface AudioResult {
  storageKey: string;
  durationMs: number;
}

export interface RenderResult {
  storageKey: string;
  durationMs: number;
}

/**
 * Text generation: plans, captions, scripts.
 *
 * One interface rather than three because the same model serves all three, and
 * splitting them would let a provider be swapped for one capability at a time -
 * which is a decision nobody would make deliberately.
 */
export interface TextProvider {
  readonly name: string;
  plan(input: { goal: string; days: number; brand: BrandContext }): Promise<ContentPlan>;
  caption(input: { angle: string; brand: BrandContext }): Promise<CaptionResult>;
  script(input: { caption: string; scenes: number }): Promise<ScriptResult>;
}

export interface ImageProvider {
  readonly name: string;
  /** One image per call; a carousel is several calls, and each is its own cost. */
  generate(input: {
    prompt: string;
    index: number;
    kind: GenerationKind;
    width: number;
    height: number;
  }): Promise<ImageResult>;
}

export interface TtsProvider {
  readonly name: string;
  speak(input: { text: string; voice: string }): Promise<AudioResult>;
}

export interface RendererProvider {
  readonly name: string;
  /** Stitches images + audio into a video. FFmpeg in production, a stub in tests. */
  render(input: {
    scenes: Array<{ imageKey: string; audioKey: string }>;
    width: number;
    height: number;
  }): Promise<RenderResult>;
}

/** The brand voice, injected into prompts. Treated as untrusted data downstream. */
export interface BrandContext {
  name: string;
  industry?: string | null;
  tone?: string | null;
  audience?: string | null;
  colors: string[];
  languages: string[];
}

/** Which providers a given job kind needs. Keeps the runner honest. */
export const STAGE_FOR_KIND: Readonly<Record<GenerationKind, JobStage>> = {
  CONTENT_PLAN: 'PLAN',
  CAPTION: 'SCRIPT',
  POSTER: 'IMAGE',
  CAROUSEL: 'IMAGE',
  REEL: 'VOICE',
  REGENERATE_SCENE: 'IMAGE',
  TRANSLATION: 'SCRIPT',
};

export const ALL_STAGES: readonly JobStage[] = JOB_STAGES;
