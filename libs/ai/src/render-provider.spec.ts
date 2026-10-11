import { ProviderError } from './providers';
import {
  FfmpegRendererProvider,
  buildSrt,
  escapeFilterText,
  findFont,
  scenesToCues,
  srtTimestamp,
} from './render-provider';

describe('srtTimestamp', () => {
  it('formats as HH:MM:SS,mmm with a comma', () => {
    // A full stop instead of a comma produces a file players treat as empty, and
    // the symptom is a reel with no captions and no error anywhere.
    expect(srtTimestamp(0)).toBe('00:00:00,000');
    expect(srtTimestamp(1_500)).toBe('00:00:01,500');
    expect(srtTimestamp(61_001)).toBe('00:01:01,001');
    expect(srtTimestamp(3_661_007)).toBe('01:01:01,007');
  });

  it('clamps a negative time rather than emitting nonsense', () => {
    expect(srtTimestamp(-500)).toBe('00:00:00,000');
  });
});

describe('scenesToCues', () => {
  it('chains cues end to end', () => {
    const cues = scenesToCues(
      [
        { narration: 'one', durationMs: 2_000 },
        { narration: 'two', durationMs: 3_000 },
      ],
      1_000,
    );

    expect(cues).toEqual([
      { index: 1, startMs: 0, endMs: 2_000, text: 'one' },
      { index: 2, startMs: 2_000, endMs: 5_000, text: 'two' },
    ]);
  });

  it('falls back to the default duration', () => {
    expect(scenesToCues([{ narration: 'x' }], 1_500)[0]).toMatchObject({
      startMs: 0,
      endMs: 1_500,
    });
  });
});

describe('buildSrt', () => {
  it('emits the numbered blocks players expect', () => {
    const srt = buildSrt([{ index: 1, startMs: 0, endMs: 1_000, text: 'hello' }]);

    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\nhello\n\n');
  });
});

describe('escapeFilterText', () => {
  it('escapes the characters an ffmpeg filter graph treats as syntax', () => {
    // "Bob's: the sequel" unescaped is a filter graph that fails to parse - or,
    // worse, one that parses as something else.
    const escaped = escapeFilterText("Bob's: the [sequel], v1\\0");

    expect(escaped).toContain("\\'");
    expect(escaped).toContain('\\:');
    expect(escaped).toContain('\\[');
    expect(escaped).toContain('\\]');
    expect(escaped).toContain('\\,');
    expect(escaped).toContain('\\\\0');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeFilterText('Northwind')).toBe('Northwind');
  });
});

describe('findFont', () => {
  it('returns null rather than throwing when nothing is installed', async () => {
    // The watermark degrades; it must never be the reason a reel fails.
    await expect(findFont('/nonexistent/font.ttf')).resolves.not.toThrow();
  });
});

describe('FfmpegRendererProvider argument building', () => {
  function storageStub() {
    const put: unknown[] = [];
    return {
      put,
      storage: {
        getObject: async () => new Uint8Array(0),
        putObject: async (input: unknown) => {
          put.push(input);
          return {};
        },
      },
    };
  }

  it('refuses a reel with no scenes before touching ffmpeg', async () => {
    const { storage } = storageStub();
    const provider = new FfmpegRendererProvider({ storage, ffmpegPath: '/definitely/not/ffmpeg' });

    await expect(
      provider.renderJob({ jobId: 'j', scenes: [], width: 1080, height: 1920 }),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });
  });

  it('reports a missing ffmpeg as PERMANENT, not a mysterious failure', async () => {
    const { storage } = storageStub();
    const provider = new FfmpegRendererProvider({
      storage,
      ffmpegPath: '/nonexistent/ffmpeg',
      ffprobePath: '/nonexistent/ffprobe',
    });

    const error = await provider
      .renderJob({
        jobId: 'j',
        scenes: [{ imageKey: 'a.png', audioKey: 'a.mp3', durationMs: 1_000 }],
        width: 320,
        height: 240,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/ffmpeg failed/);
  });

  it('exposes the renderer name for logs and metrics', () => {
    const { storage } = storageStub();
    expect(new FfmpegRendererProvider({ storage }).name).toBe('ffmpeg');
  });
});
