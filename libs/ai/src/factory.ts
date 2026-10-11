import type { GenerationKind } from '@renderflow/common';

import {
  MockImageProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from './mock-providers';
import { ElevenLabsTtsProvider, ReplicateImageProvider, type MediaSink } from './media-providers';
import { AnthropicTextProvider, OpenAiTextProvider, type FetchLike } from './text-providers';
import { FfmpegRendererProvider, type RendererStorage } from './render-provider';
import type { ImageProvider, RendererProvider, TextProvider, TtsProvider } from './providers';
import { ProviderError } from './providers';
import { withFallback } from './runtime';

/**
 * Which provider a process should use (PROJECT.md section 12 Phase 6).
 *
 * `AI_PROVIDER=mock` is the default everywhere that is not production, and the
 * Phase 6 DoD requires that flipping it back keeps the whole suite green. That
 * is only true if mock and real are genuinely interchangeable, which means this
 * factory returns the SAME INTERFACES and the only difference between the two
 * configurations is which object is behind them.
 *
 * `AI_PROVIDER` selects the TEXT provider. Images and TTS have their own
 * variables because they are separately billable and separately likely to be
 * unavailable - a replica outage should not stop captions being written. Mixing
 * a mock text provider with real image generation is a legitimate and useful
 * combination, and forcing one variable to control all three would make it
 * impossible.
 */

export type ProviderName = 'mock' | 'openai' | 'anthropic';

export interface ProviderEnv {
  AI_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  IMAGE_PROVIDER?: string;
  REPLICATE_API_TOKEN?: string;
  TTS_PROVIDER?: string;
  ELEVENLABS_API_KEY?: string;
  /** Comma-separated preference order for text, e.g. "anthropic,openai". */
  TEXT_PROVIDER_FALLBACKS?: string;
}

export interface ProviderFactoryOptions {
  env: ProviderEnv;
  /** Where image and TTS output goes. */
  sink: MediaSink;
  /** The storage the renderer reads and writes through. */
  rendererStorage: RendererStorage;
  /** Where a rendered reel goes, and what is drawn on it. */
  watermark?: string;
  watermarkColor?: string;
  /** Injectable transport, so a test can exercise the real providers offline. */
  fetchImpl?: FetchLike;
  storagePrefix?: string;
}

export interface Providers {
  text: TextProvider;
  image: ImageProvider;
  tts: TtsProvider;
  renderer: RendererProvider;
  /** True when every provider is the deterministic mock. */
  allMock: boolean;
}

/**
 * A missing key is a configuration error, not a runtime surprise.
 *
 * Failing at boot with "OPENAI_API_KEY is required" is the difference between a
 * five-second fix and a job that 500s on the first reel for an hour. The error is
 * raised only when a REAL provider was actually selected - asking for mock with
 * no keys is the normal local setup and must keep working.
 */
export function requireKey(env: ProviderEnv, name: keyof ProviderEnv): string {
  const value = env[name];

  if (value === undefined || value.trim() === '') {
    throw new ProviderError(
      `${name} is required for the selected provider. Set it, or set AI_PROVIDER=mock.`,
      'PERMANENT',
    );
  }

  return value;
}

export function textPreference(env: ProviderEnv): ProviderName[] {
  const isProvider = (name: string): name is ProviderName =>
    name === 'openai' || name === 'anthropic' || name === 'mock';

  const configured = (env.TEXT_PROVIDER_FALLBACKS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(isProvider);

  if (configured.length > 0) {
    return configured;
  }

  const primary = (env.AI_PROVIDER ?? 'mock').trim();
  const chosen: ProviderName = primary === 'openai' || primary === 'anthropic' ? primary : 'mock';

  if (chosen === 'mock') {
    return ['mock'];
  }

  // The sensible default chain: the chosen provider first, then the other. Both
  // refuse rather than returning garbage, and a refusal STOPS the chain - so a
  // fallback can never route around a content decision.
  return [chosen, chosen === 'anthropic' ? 'openai' : 'anthropic'];
}

function buildText(env: ProviderEnv, options: ProviderFactoryOptions): TextProvider {
  const transport = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  const preference = textPreference(env);

  if (preference.length === 1 && preference[0] === 'mock') {
    const mock = mockOptionsFromEnv();
    return new MockTextProvider(mock);
  }

  const providers = preference.map((name) => ({
    name,
    build: () => {
      if (name === 'openai') {
        return new OpenAiTextProvider({ apiKey: requireKey(env, 'OPENAI_API_KEY'), ...transport });
      }
      if (name === 'anthropic') {
        return new AnthropicTextProvider({
          apiKey: requireKey(env, 'ANTHROPIC_API_KEY'),
          ...transport,
        });
      }
      return new MockTextProvider(mockOptionsFromEnv());
    },
  }));

  // Each provider is CONSTRUCTED when the chain reaches it, not up front.
  // Building them all eagerly would demand an API key for a provider that might
  // never be used - so a deployment with one key could not fall back at all.
  return {
    name: `chain:${preference.join('>')}`,
    plan: async (input) =>
      (
        await withFallback({
          providers: providers.map((provider) => ({
            name: provider.name,
            call: async () => provider.build().plan(input),
          })),
          timeoutMs: 45_000,
        })
      ).value,
    caption: async (input) =>
      (
        await withFallback({
          providers: providers.map((provider) => ({
            name: provider.name,
            call: async () => provider.build().caption(input),
          })),
          timeoutMs: 45_000,
        })
      ).value,
    script: async (input) =>
      (
        await withFallback({
          providers: providers.map((provider) => ({
            name: provider.name,
            call: async () => provider.build().script(input),
          })),
          timeoutMs: 45_000,
        })
      ).value,
  };
}

function buildImage(env: ProviderEnv, options: ProviderFactoryOptions): ImageProvider {
  if ((env.IMAGE_PROVIDER ?? 'mock').trim() === 'mock') {
    return new MockImageProvider(mockOptionsFromEnv());
  }

  const prefix = options.storagePrefix ?? 'generated/images';

  return new ReplicateImageProvider({
    apiKey: requireKey(env, 'REPLICATE_API_TOKEN'),
    sink: options.sink,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    outputFor: (index: number, kind: GenerationKind) =>
      `${prefix}/${kind.toLowerCase()}-${index}.png`,
  });
}

function buildTts(env: ProviderEnv, options: ProviderFactoryOptions): TtsProvider {
  if ((env.TTS_PROVIDER ?? 'mock').trim() === 'mock') {
    return new MockTtsProvider(mockOptionsFromEnv());
  }

  return new ElevenLabsTtsProvider({
    apiKey: requireKey(env, 'ELEVENLABS_API_KEY'),
    sink: options.sink,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

function buildRenderer(options: ProviderFactoryOptions): RendererProvider {
  // The renderer is real even in mock mode.
  //
  // It has no API key, no network and no cost, and it is the one component whose
  // behaviour the user actually sees. Mocking it would mean the reel a developer
  // watches in local dev is not the reel production produces.
  return new FfmpegRendererProvider({
    storage: options.rendererStorage,
    ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
    ...(options.watermarkColor === undefined ? {} : { watermarkColor: options.watermarkColor }),
  });
}

export function createProviders(options: ProviderFactoryOptions): Providers {
  const env = options.env;
  const preference = textPreference(env);
  const allMock =
    preference.length === 1 &&
    preference[0] === 'mock' &&
    (env.IMAGE_PROVIDER ?? 'mock').trim() === 'mock' &&
    (env.TTS_PROVIDER ?? 'mock').trim() === 'mock';

  return {
    text: buildText(env, options),
    image: buildImage(env, options),
    tts: buildTts(env, options),
    renderer: buildRenderer(options),
    allMock,
  };
}
