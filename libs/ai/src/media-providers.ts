import { z } from 'zod';

import type { GenerationKind } from '@renderflow/common';

import { ProviderError, type AudioResult, type ImageResult } from './providers';
import { ConcurrencyLimiter, callWithRetries } from './runtime';
import type { FetchLike } from './text-providers';

/**
 * Real image and TTS providers (PROJECT.md section 12 Phase 6: "Image and TTS
 * providers").
 *
 * Both follow the same rule as the text providers: an injectable transport, so
 * the suite drives the production code path and only the socket is stubbed.
 *
 * Both return a STORAGE KEY rather than bytes, because the interface does and
 * because a reel's worth of images should never pass through worker memory twice.
 * The provider writes into `outputFor`, which the worker wires to the real bucket.
 */

/** Where a provider puts its output. Narrower than the full storage provider. */
export interface MediaSink {
  put(input: { key: string; body: Uint8Array; contentType: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Where the generated object goes; the worker wires this to the real bucket. */
  sink: MediaSink;
  outputFor: (index: number, kind: GenerationKind) => string;
  timeoutMs?: number;
  attempts?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
}

/** Replicate's synchronous prediction shape. */
const replicateResponseSchema = z.object({
  output: z.union([z.string(), z.array(z.string())]).optional(),
  error: z.string().optional(),
  status: z.string().optional(),
});

export class ReplicateImageProvider {
  readonly name = 'replicate';

  constructor(private readonly options: ImageProviderOptions) {}

  async generate(input: {
    prompt: string;
    index: number;
    kind: GenerationKind;
    width: number;
    height: number;
  }): Promise<ImageResult> {
    const limiter = new ConcurrencyLimiter(this.options.concurrency ?? 2);

    return limiter.run(() =>
      callWithRetries(
        this.name,
        async (signal) => {
          const key = await this.request(input, signal);
          return {
            storageKey: key,
            // Replicate does not echo the dimensions back, so the requested ones
            // are what the checkpoint records. Recording a guess would let the
            // renderer build a filter graph for a size the file is not.
            width: input.width,
            height: input.height,
          };
        },
        {
          name: this.name,
          timeoutMs: this.options.timeoutMs ?? 60_000,
          // Image generation is slow and flaky by nature; two attempts, not
          // three, because each retry is a billable generation.
          policy: { attempts: this.options.attempts ?? 2, backoffMs: 1_000 },
        },
      ),
    );
  }

  private async request(
    input: { prompt: string; index: number; kind: GenerationKind; width: number; height: number },
    signal: AbortSignal,
  ): Promise<string> {
    const doFetch: FetchLike | undefined = this.options.fetchImpl ?? globalThis.fetch;

    if (doFetch === undefined) {
      throw new ProviderError('no fetch implementation available', 'PERMANENT');
    }

    const response = await doFetch(
      `${this.options.baseUrl ?? 'https://api.replicate.com/v1'}/models/${this.options.model ?? 'black-forest-labs/flux-schnell'}/predictions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          prefer: 'wait',
        },
        body: JSON.stringify({
          input: {
            prompt: input.prompt,
            width: input.width,
            height: input.height,
            aspect_ratio: aspectFor(input.width, input.height),
          },
        }),
        signal,
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `image generation failed (${response.status}): ${detail.slice(0, 300)}`,
        response.status >= 500 || response.status === 429 ? 'TRANSIENT' : 'PERMANENT',
      );
    }

    const parsed = replicateResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new ProviderError(
        `unreadable image response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'TRANSIENT',
      );
    }

    // A 200 with an error field is Replicate's way of reporting a refusal, and
    // treating it as success would write a broken file and record a checkpoint.
    if (parsed.data.error !== undefined) {
      throw new ProviderError(`image generation refused: ${parsed.data.error}`, 'PERMANENT');
    }

    const output = parsed.data.output;
    const url = Array.isArray(output) ? output[0] : output;

    if (url === undefined || url === '') {
      // 202 with nothing in it means the prediction is still running; `prefer:
      // wait` was refused. That is transient, not a failure.
      throw new ProviderError('image generation returned no output', 'TRANSIENT');
    }

    const image = await doFetch(url, { signal });
    if (!image.ok) {
      throw new ProviderError(`image download failed (${image.status})`, 'TRANSIENT');
    }

    const key = this.options.outputFor(input.index, input.kind);
    await this.options.sink.put({
      key,
      body: new Uint8Array(await image.arrayBuffer()),
      contentType: contentTypeFor(url),
    });

    return key;
  }
}

/**
 * Content type from the URL.
 *
 * Models return .png, .jpg and .webp from the same field; storing every one as
 * image/png means a browser is handed a JPEG with the wrong header.
 */
export function contentTypeFor(url: string): string {
  if (/\.jpe?g($|\?)/i.test(url)) return 'image/jpeg';
  if (/\.webp($|\?)/i.test(url)) return 'image/webp';
  return 'image/png';
}

/** The aspect ratio a model wants, derived from the dimensions we asked for. */
export function aspectFor(width: number, height: number): string {
  const ratio = width / height;

  if (ratio > 1.15) return '16:9';
  if (ratio > 0.95) return '1:1';
  if (ratio > 0.6) return '4:5';
  return '9:16';
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

export interface TtsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  model?: string;
  sink: MediaSink;
  timeoutMs?: number;
  attempts?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
  /** Overridable so a test does not depend on ffprobe. */
  durationOf?: (bytes: Uint8Array) => Promise<number>;
}

/**
 * ElevenLabs.
 *
 * The duration is measured from the bytes we actually received rather than
 * estimated from the character count, because the estimate is what makes a
 * renderer's scene timings drift: a still held for longer than its narration is
 * dead air the user sees.
 */
export class ElevenLabsTtsProvider {
  readonly name = 'elevenlabs';

  constructor(private readonly options: TtsProviderOptions) {}

  async speak(input: { text: string; voice: string }): Promise<AudioResult> {
    const limiter = new ConcurrencyLimiter(this.options.concurrency ?? 4);

    return limiter.run(() =>
      callWithRetries(
        this.name,
        async (signal) => {
          const doFetch: FetchLike | undefined = this.options.fetchImpl ?? globalThis.fetch;

          if (doFetch === undefined) {
            throw new ProviderError('no fetch implementation available', 'PERMANENT');
          }

          const response = await doFetch(
            `${this.options.baseUrl ?? 'https://api.elevenlabs.io/v1'}/text-to-speech/${this.options.voiceId ?? '21m00Tcm4TlvDq8ikWAM'}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'audio/mpeg',
                'xi-api-key': this.options.apiKey,
              },
              body: JSON.stringify({
                text: input.text,
                model_id: this.options.model ?? 'eleven_turbo_v2_5',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
              }),
              signal,
            },
          );

          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new ProviderError(
              `text-to-speech failed (${response.status}): ${detail.slice(0, 300)}`,
              response.status >= 500 || response.status === 429 ? 'TRANSIENT' : 'PERMANENT',
            );
          }

          const body = new Uint8Array(await response.arrayBuffer());
          const key = `generated/voice/${hashOf(input.text)}.mp3`;

          await this.options.sink.put({ key, body, contentType: 'audio/mpeg' });

          return {
            storageKey: key,
            durationMs: await this.measure(body),
          };
        },
        {
          name: this.name,
          timeoutMs: this.options.timeoutMs ?? 30_000,
          policy: { attempts: this.options.attempts ?? 2, backoffMs: 500 },
        },
      ),
    );
  }

  private async measure(body: Uint8Array): Promise<number> {
    if (this.options.durationOf !== undefined) {
      return this.options.durationOf(body);
    }

    // Without a decoder, the honest answer is "unknown" rather than an estimate:
    // the renderer falls back to its default scene length and the reel is still
    // correct, just possibly a little dead.
    return 0;
  }
}

/**
 * A stable key for a piece of narration.
 *
 * Content-addressed so the same narration across a retry does not write a second
 * object, and so two reels with the same text share it.
 */
export function hashOf(text: string): string {
  let hash = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
