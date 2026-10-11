import {
  ElevenLabsTtsProvider,
  ReplicateImageProvider,
  contentTypeFor,
  type MediaSink,
} from './media-providers';
import type { GenerationKind } from '@renderflow/common';

import { ProviderError } from './providers';

/**
 * Image and TTS providers through a stub transport.
 *
 * The properties worth pinning are the ones that silently produce a broken
 * asset: a 200 carrying an error, a prediction still running, an image stored
 * under the wrong content type.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface ScriptedStep {
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
}

function stubFetch(script: ScriptedStep[]): {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  return {
    calls,
    fetchImpl: async (url, init) => {
      const raw = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {});
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: raw === '{}' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      // Past the end of the script, reuse the last entry: a provider that makes
      // a second call should be visible as "called twice", not as a crash.
      const step = script[Math.min(index, script.length - 1)] ?? {};
      index += 1;
      const status = step.status ?? 200;

      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => step.json ?? {},
        text: async () => JSON.stringify(step.json ?? {}),
        arrayBuffer: async () => (step.bytes ?? new Uint8Array([1, 2, 3])).buffer,
      } as unknown as Response;
    },
  };
}

function collectingSink(): MediaSink & {
  puts: Array<{ key: string; contentType: string; size: number }>;
} {
  const puts: Array<{ key: string; contentType: string; size: number }> = [];
  return {
    puts,
    put: async ({ key, body, contentType }) => {
      puts.push({ key, contentType, size: body.byteLength });
    },
  };
}

const imageOptions = (
  sink: MediaSink,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
) => ({
  apiKey: 'r8-test',
  sink,
  fetchImpl,
  outputFor: (index: number, kind: GenerationKind) =>
    `generated/images/${kind.toLowerCase()}-${index}.png`,
});

describe('ReplicateImageProvider', () => {
  it('asks for the right aspect ratio and size', async () => {
    const sink = collectingSink();
    const { fetchImpl, calls } = stubFetch([
      { json: { output: 'https://replicate.delivery/a.png' } },
      { bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const provider = new ReplicateImageProvider(imageOptions(sink, fetchImpl));

    const result = await provider.generate({
      prompt: 'a rainy platform',
      index: 1,
      kind: 'REEL',
      width: 1080,
      height: 1920,
    });

    expect(calls[0]?.body.input).toMatchObject({ width: 1080, height: 1920, aspect_ratio: '9:16' });
    expect(result.storageKey).toBe('generated/images/reel-1.png');
    expect(result).toMatchObject({ width: 1080, height: 1920 });
  });

  it('writes the bytes it downloaded', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([
      { json: { output: 'https://replicate.delivery/a.png' } },
      { bytes: new Uint8Array([9, 9, 9, 9, 9]) },
    ]);

    await new ReplicateImageProvider(imageOptions(sink, fetchImpl)).generate({
      prompt: 'x',
      index: 1,
      kind: 'POSTER',
      width: 512,
      height: 512,
    });

    // A checkpoint that references an object nobody wrote is how a reel fails
    // at render time, an hour after the credit was spent.
    expect(sink.puts).toEqual([
      { key: 'generated/images/poster-1.png', contentType: 'image/png', size: 5 },
    ]);
  });

  it('stores a JPEG as a JPEG', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([
      { json: { output: 'https://replicate.delivery/a.jpg' } },
      { bytes: new Uint8Array([1]) },
    ]);

    await new ReplicateImageProvider(imageOptions(sink, fetchImpl)).generate({
      prompt: 'x',
      index: 1,
      kind: 'POSTER',
      width: 512,
      height: 512,
    });

    // Every model returns a different extension from the same field; storing them
    // all as image/png hands a browser a JPEG with the wrong header.
    expect(sink.puts[0]?.contentType).toBe('image/jpeg');
  });

  it('treats a 200 carrying an error as a refusal, not a success', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ json: { error: 'input flagged by moderation' } }]);

    // Accepting it would write a broken file and record a checkpoint for media
    // that was never produced.
    await expect(
      new ReplicateImageProvider({ ...imageOptions(sink, fetchImpl), attempts: 1 }).generate({
        prompt: 'x',
        index: 1,
        kind: 'POSTER',
        width: 512,
        height: 512,
      }),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });

    expect(sink.puts).toHaveLength(0);
  });

  it('treats an empty 200 as transient', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ json: { status: 'processing' } }]);

    // 202 with nothing in it means the prediction is still running. Retrying is
    // right; refunding the user is not.
    await expect(
      new ReplicateImageProvider({ ...imageOptions(sink, fetchImpl), attempts: 1 }).generate({
        prompt: 'x',
        index: 1,
        kind: 'POSTER',
        width: 512,
        height: 512,
      }),
    ).rejects.toMatchObject({ classification: 'TRANSIENT' });
  });

  it('treats a 500 as transient and a 401 as permanent', async () => {
    const sink = collectingSink();
    const up = stubFetch([{ status: 500 }]);
    const badKey = stubFetch([{ status: 401 }]);

    await expect(
      new ReplicateImageProvider({ ...imageOptions(sink, up.fetchImpl), attempts: 1 }).generate({
        prompt: 'x',
        index: 1,
        kind: 'POSTER',
        width: 512,
        height: 512,
      }),
    ).rejects.toMatchObject({ classification: 'TRANSIENT' });

    await expect(
      new ReplicateImageProvider({ ...imageOptions(sink, badKey.fetchImpl), attempts: 1 }).generate(
        {
          prompt: 'x',
          index: 1,
          kind: 'POSTER',
          width: 512,
          height: 512,
        },
      ),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });
  });

  it('retries once by default, not three times', async () => {
    // Each retry is a billable generation. Three attempts on a 4-image carousel
    // is nine generations the user is billed for four.
    const sink = collectingSink();
    const { fetchImpl, calls } = stubFetch([{ status: 500 }]);

    await expect(
      new ReplicateImageProvider(imageOptions(sink, fetchImpl)).generate({
        prompt: 'x',
        index: 1,
        kind: 'CAROUSEL',
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(2);
  });

  it('raises a typed error rather than a string', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ status: 500 }]);

    await expect(
      new ReplicateImageProvider({ ...imageOptions(sink, fetchImpl), attempts: 1 }).generate({
        prompt: 'x',
        index: 1,
        kind: 'POSTER',
        width: 512,
        height: 512,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('ElevenLabsTtsProvider', () => {
  it('sends the key and returns a content-addressed key', async () => {
    const sink = collectingSink();
    const { fetchImpl, calls } = stubFetch([{ bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) }]);

    const result = await new ElevenLabsTtsProvider({
      apiKey: 'eleven-test',
      sink,
      fetchImpl,
    }).speak({ text: 'Rain again.', voice: 'en-GB' });

    expect(calls[0]?.headers['xi-api-key']).toBe('eleven-test');
    expect(calls[0]?.body.text).toBe('Rain again.');
    expect(result.storageKey).toBe(`generated/voice/${hashOfText('Rain again.')}.mp3`);
    expect(sink.puts[0]?.contentType).toBe('audio/mpeg');
  });

  it('reuses the same key for the same narration', async () => {
    // Content-addressed so a retry does not write a second object, and so two
    // reels with the same line share one.
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ bytes: new Uint8Array([1]) }]);
    const provider = new ElevenLabsTtsProvider({ apiKey: 'k', sink, fetchImpl });

    const first = await provider.speak({ text: 'same', voice: 'v' });
    const second = await provider.speak({ text: 'same', voice: 'v' });

    expect(first.storageKey).toBe(second.storageKey);
    expect(sink.puts).toHaveLength(2);
  });

  it('uses the injected duration measurement when given one', async () => {
    // The renderer needs a real length: an estimate from character count is what
    // makes scene timings drift into dead air.
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ bytes: new Uint8Array([1]) }]);

    const result = await new ElevenLabsTtsProvider({
      apiKey: 'k',
      sink,
      fetchImpl,
      durationOf: async () => 4_250,
    }).speak({ text: 'hello', voice: 'v' });

    expect(result.durationMs).toBe(4_250);
  });

  it('reports an unknown duration rather than a guess', async () => {
    const sink = collectingSink();
    const { fetchImpl } = stubFetch([{ bytes: new Uint8Array([1]) }]);

    const result = await new ElevenLabsTtsProvider({ apiKey: 'k', sink, fetchImpl }).speak({
      text: 'hello',
      voice: 'v',
    });

    // 0 means "unknown", and the renderer falls back to its default. A confident
    // wrong number is worse than none.
    expect(result.durationMs).toBe(0);
  });

  it('treats a rate limit as transient and a rejection as permanent', async () => {
    const sink = collectingSink();

    await expect(
      new ElevenLabsTtsProvider({
        apiKey: 'k',
        sink,
        fetchImpl: stubFetch([{ status: 429 }]).fetchImpl,
        attempts: 1,
      }).speak({ text: 'x', voice: 'v' }),
    ).rejects.toMatchObject({ classification: 'TRANSIENT' });

    await expect(
      new ElevenLabsTtsProvider({
        apiKey: 'k',
        sink,
        fetchImpl: stubFetch([{ status: 400 }]).fetchImpl,
        attempts: 1,
      }).speak({ text: 'x', voice: 'v' }),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });
  });
});

describe('contentTypeFor', () => {
  it('maps the extensions models actually return', () => {
    expect(contentTypeFor('https://x/a.png')).toBe('image/png');
    expect(contentTypeFor('https://x/a.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('https://x/a.jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('https://x/a.webp')).toBe('image/webp');
  });

  it('survives a signed URL with a query string', () => {
    expect(contentTypeFor('https://x/a.jpg?Expires=1&Signature=2')).toBe('image/jpeg');
  });

  it('defaults to png rather than guessing something wrong', () => {
    expect(contentTypeFor('https://x/abc')).toBe('image/png');
  });
});

function hashOfText(text: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
