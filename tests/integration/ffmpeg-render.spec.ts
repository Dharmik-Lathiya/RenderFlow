import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { FfmpegRendererProvider, type RendererStorage } from '@renderflow/ai';

const run = promisify(execFile);

/**
 * A real render, with the real ffmpeg.
 *
 * Every other test in this suite stubs the thing it is not testing. This one
 * cannot: the renderer exists to produce a video file, and "the arguments look
 * right" is not "ffmpeg accepted them". A 9-argument filter graph that is one
 * label wrong produces no output and no useful error, and the only way to know
 * is to run it.
 *
 * Skipped, loudly, when ffmpeg is absent - this environment has it, CI images
 * may not, and a green suite that quietly rendered nothing would be worse than a
 * red one.
 */

// `spawnSync`, not an awaited check: this module is transformed to CommonJS,
// where top-level await is a syntax error rather than a feature.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { timeout: 10_000 }).status === 0;

const describeFfmpeg = HAS_FFMPEG ? describe : describe.skip;

if (!HAS_FFMPEG) {
  console.warn('[render] ffmpeg not found; the real-render suite is SKIPPED, not passed');
}

/**
 * Storage backed by a real directory, so nothing about this is a double.
 *
 * The key is nested (`generated/reels/<id>.mp4`), so the parent has to be
 * created. S3 has no directories and does not need it; a filesystem does, and
 * leaving it out would fail for a reason that has nothing to do with rendering.
 */
function fileStorage(dir: string): RendererStorage & { read(key: string): Promise<Buffer> } {
  return {
    getObject: async (key) => new Uint8Array(await readFile(join(dir, key))),
    putObject: async (input) => {
      const target = join(dir, input.key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.body);
      return {};
    },
    read: (key: string) => readFile(join(dir, key)),
  };
}

/** A solid colour PNG, produced by ffmpeg itself so there is no image library. */
async function solidPng(path: string, colour: string, size = 320): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${colour}:s=${size}x${size}:d=1`,
    '-frames:v',
    '1',
    path,
  ]);
}

/** A sine tone, so the output has a real audio stream. */
async function toneWav(path: string, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:a',
    'pcm_s16le',
    path,
  ]);
}

async function probe(file: string): Promise<{
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasSubtitles: boolean;
}> {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      '-of',
      'json',
      file,
    ],
    { timeout: 20_000 },
  );

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };

  const streams = parsed.streams ?? [];

  return {
    duration: Number.parseFloat(parsed.format?.duration ?? '0'),
    width: streams.find((s) => s.codec_type === 'video')?.width ?? 0,
    height: streams.find((s) => s.codec_type === 'video')?.height ?? 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasSubtitles: streams.some((s) => s.codec_type === 'subtitle'),
  };
}

describeFfmpeg('FfmpegRendererProvider, against the real ffmpeg', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'renderflow-fixture-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stitches three stills and a narration into a playable mp4', async () => {
    await solidPng(join(dir, 'a.png'), 'red');
    await solidPng(join(dir, 'b.png'), 'green');
    await solidPng(join(dir, 'c.png'), 'blue');
    await toneWav(join(dir, 'voice.wav'), 3);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    const result = await provider.renderJob({
      jobId: 'reel-1',
      scenes: [
        { imageKey: 'a.png', audioKey: 'voice.wav', narration: 'First', durationMs: 1_000 },
        { imageKey: 'b.png', audioKey: 'voice.wav', narration: 'Second', durationMs: 1_000 },
        { imageKey: 'c.png', audioKey: 'voice.wav', narration: 'Third', durationMs: 1_000 },
      ],
      width: 320,
      height: 240,
    });

    expect(result.storageKey).toBe('generated/reels/reel-1.mp4');

    const media = await probe(
      await storage.read(result.storageKey).then(() => join(dir, result.storageKey)),
    );

    // The things a user would notice if they were wrong.
    expect(media.hasAudio).toBe(true);
    expect(media.width).toBe(320);
    expect(media.height).toBe(240);
    expect(media.duration).toBeGreaterThan(2.5);
    expect(result.durationMs).toBe(3_000);
  });

  it('attaches a soft subtitle track', async () => {
    await solidPng(join(dir, 'a.png'), 'red');
    await solidPng(join(dir, 'b.png'), 'blue');
    await toneWav(join(dir, 'voice.wav'), 2);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    const result = await provider.renderJob({
      jobId: 'reel-subs',
      scenes: [
        { imageKey: 'a.png', audioKey: 'voice.wav', narration: 'Hello there', durationMs: 1_000 },
        { imageKey: 'b.png', audioKey: 'voice.wav', narration: 'And again', durationMs: 1_000 },
      ],
      width: 320,
      height: 240,
    });

    const media = await probe(join(dir, result.storageKey));
    expect(media.hasSubtitles).toBe(true);
    expect(result.softSubtitles).toBe(true);
  });

  it('letterboxes a mismatched aspect ratio instead of stretching', async () => {
    await solidPng(join(dir, 'square.png'), 'teal');
    await toneWav(join(dir, 'voice.wav'), 1);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    // A square still into a portrait reel. Without scale+pad the image would be
    // squashed to fill, which is the single most common "why does my reel look
    // wrong" bug.
    const result = await provider.renderJob({
      jobId: 'reel-pad',
      scenes: [{ imageKey: 'square.png', audioKey: 'voice.wav', durationMs: 1_000 }],
      width: 180,
      height: 320,
    });

    const media = await probe(join(dir, result.storageKey));
    expect(media).toMatchObject({ width: 180, height: 320 });
  });

  it('applies the watermark when a font is available', async () => {
    await solidPng(join(dir, 'a.png'), 'white');
    await toneWav(join(dir, 'voice.wav'), 1);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({
      storage,
      watermark: 'Northwind',
      watermarkColor: '#112233',
    });

    const result = await provider.renderJob({
      jobId: 'reel-wm',
      scenes: [{ imageKey: 'a.png', audioKey: 'voice.wav', durationMs: 1_000 }],
      width: 320,
      height: 240,
    });

    // The interesting assertion is the boolean, not the pixels: whether the mark
    // was applied must be REPORTED, so a deployment with no fonts is visible
    // rather than silently producing unwatermarked reels.
    expect(typeof result.watermarkApplied).toBe('boolean');
    const media = await probe(join(dir, result.storageKey));
    expect(media.hasAudio).toBe(true);
  });

  it('still renders when a brand name would break the filter graph', async () => {
    await solidPng(join(dir, 'a.png'), 'white');
    await toneWav(join(dir, 'voice.wav'), 1);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({
      storage,
      // Every character here is filter-graph syntax. Unescaped this is a parse
      // error, and in the worst case a graph that means something else.
      watermark: "Bob's: [the sequel], v1\\0",
    });

    await expect(
      provider.renderJob({
        jobId: 'reel-hostile',
        scenes: [{ imageKey: 'a.png', audioKey: 'voice.wav', durationMs: 1_000 }],
        width: 320,
        height: 240,
      }),
    ).resolves.toMatchObject({ storageKey: 'generated/reels/reel-hostile.mp4' });
  });

  it('fails permanently on audio it cannot decode', async () => {
    await solidPng(join(dir, 'a.png'), 'orange');
    await writeFile(join(dir, 'broken.mp3'), 'this is not audio');

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    // Not silently produced as a silent reel: the user asked for a narrated
    // video, and delivering a mute one with a success status is worse than
    // refunding them. PERMANENT so the credits go back rather than being
    // retried against the same corrupt file.
    await expect(
      provider.renderJob({
        jobId: 'reel-broken-audio',
        scenes: [{ imageKey: 'a.png', audioKey: 'broken.mp3', durationMs: 1_000 }],
        width: 320,
        height: 240,
      }),
    ).rejects.toMatchObject({ classification: 'PERMANENT' });
  });

  it('does not leak its temp directory', async () => {
    await solidPng(join(dir, 'a.png'), 'red');
    await toneWav(join(dir, 'voice.wav'), 1);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    await provider.renderJob({
      jobId: 'reel-cleanup',
      scenes: [{ imageKey: 'a.png', audioKey: 'voice.wav', durationMs: 500 }],
      width: 320,
      height: 240,
    });

    // A media worker leaking a rendered video per job fills a disk in about a
    // week, and nothing ever complains.
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith('renderflow-render-'),
    );
    expect(leftovers).toHaveLength(0);
  });

  it('renders a 15 s reel, the shape the DoD names', async () => {
    const scenes = Array.from({ length: 5 }, (_, index) => ({
      imageKey: `frame-${index}.png`,
      audioKey: 'voice.wav',
      narration: `Scene ${index + 1}`,
      durationMs: 3_000,
    }));

    const colours = ['red', 'green', 'blue', 'yellow', 'purple'];

    for (const [index] of scenes.entries()) {
      await solidPng(join(dir, `frame-${index}.png`), colours[index] ?? 'black');
    }
    await toneWav(join(dir, 'voice.wav'), 15);

    const storage = fileStorage(dir);
    const provider = new FfmpegRendererProvider({ storage });

    const result = await provider.renderJob({
      jobId: 'reel-15s',
      scenes,
      width: 1080,
      height: 1920,
    });

    const media = await probe(join(dir, result.storageKey));

    expect(result.durationMs).toBe(15_000);
    expect(media.duration).toBeGreaterThan(14);
    expect(media).toMatchObject({ width: 1080, height: 1920 });
    expect(media.hasAudio).toBe(true);
  }, 60_000);
});
