import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ProviderError, type RenderResult, type RendererProvider } from './providers';

const run = promisify(execFile);

/**
 * Real FFmpeg rendering (PROJECT.md section 12 Phase 6: "FFmpeg stitching with
 * subtitles and brand watermark").
 *
 * The `RendererProvider` interface speaks in storage keys, so this takes a
 * storage provider rather than file paths: a worker has no local files it can
 * name, and a renderer that wrote to a temp path and hoped the caller would
 * find it works on exactly one machine.
 *
 * Subtitles are a SOFT track (`mov_text`) by default. Burning them in needs
 * libass AND a font file at a path that differs on every base image; when either
 * is missing the render would fail for every reel. A soft track plays
 * everywhere and costs nothing. `burnSubtitles` opts in.
 *
 * The watermark is a `drawtext` overlay and it DEGRADES: with no font available
 * the render proceeds without it rather than failing, because a reel with no
 * watermark is worth more than no reel. Whether it was applied is reported, so a
 * silent degradation is still visible.
 *
 * Every external call is `execFile` with an argument ARRAY. Scene text reaches
 * this file from an LLM, and a shell string would turn a generated caption into a
 * command injection.
 */

/** The storage surface the renderer needs. Narrower than the full provider. */
export interface RendererStorage {
  getObject(key: string): Promise<Uint8Array>;
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<unknown>;
}

export interface FfmpegOptions {
  storage: RendererStorage;
  /** Text drawn in the corner. Omit for no watermark. */
  watermark?: string;
  /** Brand colour, `#rrggbb` or `#rrggbbaa`. */
  watermarkColor?: string;
  fontPath?: string;
  /** How long a still is held when nothing says otherwise. */
  defaultSceneMs?: number;
  /** Wall-clock budget for the whole render. */
  timeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  burnSubtitles?: boolean;
}

export interface RenderJobInput {
  jobId: string;
  scenes: Array<{
    imageKey: string;
    audioKey: string;
    narration?: string;
    durationMs?: number;
  }>;
  width: number;
  height: number;
}

export interface RenderJobResult extends RenderResult {
  /** False when the watermark was configured but could not be applied. */
  watermarkApplied: boolean;
  /** True when the caption track is attached rather than burned into the frames. */
  softSubtitles: boolean;
}

/** Formats an SRT timestamp: `HH:MM:SS,mmm`. The comma is part of the format. */
export function srtTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1_000;
  const seconds = Math.floor(total / 1_000) % 60;
  const minutes = Math.floor(total / 60_000) % 60;
  const hours = Math.floor(total / 3_600_000);

  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export function buildSrt(cues: readonly SrtCue[]): string {
  return `${cues
    .map(
      (cue) =>
        `${cue.index}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n')}\n`;
}

export function scenesToCues(
  scenes: ReadonlyArray<{ narration?: string; durationMs?: number }>,
  defaultMs: number,
): SrtCue[] {
  let cursor = 0;

  return scenes.map((scene, index) => {
    const duration = scene.durationMs ?? defaultMs;
    const cue: SrtCue = {
      index: index + 1,
      startMs: cursor,
      endMs: cursor + duration,
      text: (scene.narration ?? '').trim(),
    };
    cursor = cue.endMs;
    return cue;
  });
}

/** The first path that exists, or null. `drawtext` needs a file, not a family. */
export async function findFont(explicit?: string): Promise<string | null> {
  const candidates = [
    explicit,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/NotoSans-Regular.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ].filter((path): path is string => path !== undefined && path !== '');

  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch {
      // Next candidate.
    }
  }

  return null;
}

/**
 * Escapes text for an ffmpeg filter graph.
 *
 * `:` separates options, `'` quotes them and `\` escapes. An unescaped brand name
 * of "Bob's: the sequel" is a filter graph that fails to parse - or, worse, one
 * that parses as something else.
 */
export function escapeFilterText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

export class FfmpegRendererProvider implements RendererProvider {
  readonly name = 'ffmpeg';

  constructor(private readonly options: FfmpegOptions) {}

  async render(input: {
    scenes: Array<{ imageKey: string; audioKey: string }>;
    width: number;
    height: number;
  }): Promise<RenderResult> {
    const { watermarkApplied, softSubtitles, ...result } = await this.renderJob({
      jobId: 'unscoped',
      scenes: input.scenes,
      width: input.width,
      height: input.height,
    });
    void watermarkApplied;
    void softSubtitles;
    return result;
  }

  /**
   * The job-aware entry point the worker calls.
   *
   * `render()` above cannot know the job id, because the interface does not
   * carry one; it therefore produces a generic key. The worker uses this instead,
   * because that key is what the asset row and the checkpoint both refer to.
   */
  async renderJob(input: RenderJobInput): Promise<RenderJobResult> {
    if (input.scenes.length === 0) {
      throw new ProviderError('cannot render a reel with no scenes', 'PERMANENT');
    }

    const dir = await mkdtemp(join(tmpdir(), 'renderflow-render-'));

    try {
      const imagePaths: string[] = [];
      const durations: number[] = [];

      // One narration track for the whole reel: VOICE produces a single audio
      // file and every scene references it. Its length is what sets each still's
      // duration when the scene does not say.
      const firstScene = input.scenes[0];
      if (firstScene === undefined) {
        throw new ProviderError('cannot render a reel with no scenes', 'PERMANENT');
      }

      const audioPath = join(dir, 'audio.mp3');
      await writeFile(audioPath, await this.options.storage.getObject(firstScene.audioKey));
      const narrationMs = (await this.audioLength(audioPath)) * 1_000;

      for (const [index, scene] of input.scenes.entries()) {
        const path = join(dir, `scene-${index}.png`);
        await writeFile(path, await this.options.storage.getObject(scene.imageKey));
        imagePaths.push(path);

        // Explicit duration wins; then the narration length; then the default.
        // `narrationMs > 0` rather than `??`: an unreadable audio file yields 0,
        // and `0 ?? 3000` is 0 - a reel of stills with no time on screen.
        durations.push(
          scene.durationMs ??
            (narrationMs > 0 ? narrationMs : (this.options.defaultSceneMs ?? 3_000)),
        );
      }

      const srtPath = join(dir, 'captions.srt');
      await writeFile(
        srtPath,
        buildSrt(scenesToCues(input.scenes, this.options.defaultSceneMs ?? 3_000)),
        'utf8',
      );

      const font = await findFont(this.options.fontPath);
      const watermarkApplied =
        this.options.watermark !== undefined && this.options.watermark !== '' && font !== null;

      const outputPath = join(dir, 'out.mp4');
      await this.invoke(
        this.buildArgs({
          imagePaths,
          audioPath,
          srtPath,
          outputPath,
          durations,
          input,
          font,
          watermarkApplied,
          totalMs: Math.max(
            durations.reduce((sum, ms) => sum + ms, 0),
            narrationMs,
          ),
        }),
      );

      const key = `generated/reels/${input.jobId}.mp4`;
      await this.options.storage.putObject({
        key,
        body: new Uint8Array(await readFile(outputPath)),
        contentType: 'video/mp4',
        metadata: { width: String(input.width), height: String(input.height) },
      });

      return {
        storageKey: key,
        durationMs: durations.reduce((total, ms) => total + ms, 0),
        watermarkApplied,
        softSubtitles: this.options.burnSubtitles !== true,
      };
    } finally {
      // Always, including on failure. A leaked temp directory full of rendered
      // video is how a media worker fills a disk over a week.
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Length of the narration in seconds, or 0 when ffprobe cannot tell us. */
  private async audioLength(path: string): Promise<number> {
    try {
      const { stdout } = await run(
        this.options.ffprobePath ?? 'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        { timeout: 15_000 },
      );
      const seconds = Number.parseFloat(stdout.trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    } catch {
      // Unreadable audio must not fail the render: the video is still worth
      // producing, silent if it has to be.
      return 0;
    }
  }

  private buildArgs(context: {
    imagePaths: readonly string[];
    audioPath: string;
    srtPath: string;
    outputPath: string;
    durations: readonly number[];
    input: RenderJobInput;
    font: string | null;
    watermarkApplied: boolean;
    /** Length of the finished video: whichever of stills or narration is longer. */
    totalMs: number;
  }): string[] {
    const { width, height } = context.input;
    const args: string[] = ['-y'];

    for (const [index, ms] of context.durations.entries()) {
      const imagePath = context.imagePaths[index];
      if (imagePath === undefined) {
        throw new ProviderError('scene image missing from the render inputs', 'PERMANENT');
      }
      // Each still gets its own input, looped for its own duration. Feeding them
      // through one input with a concat filter and hoping they line up is how a
      // reel comes out with the wrong scene on screen.
      args.push('-loop', '1', '-t', (ms / 1_000).toFixed(3), '-i', imagePath);
    }

    const srtIndex = context.durations.length;
    const audioIndex = context.durations.length + 1;
    args.push('-i', context.srtPath, '-i', context.audioPath);

    const filters: string[] = [];
    const count = context.durations.length;

    for (let index = 0; index < count; index += 1) {
      // scale+pad rather than a bare scale: a 4:3 still in a 9:16 reel must be
      // letterboxed, not stretched.
      filters.push(
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`,
      );
    }

    // The watermark is drawn on the LAST scene only, and then fed into concat as
    // that scene's stream. Drawing it afterwards on the concatenated video would
    // burn the text into every frame for the whole reel; drawing it on each
    // input and concatenating the results is what keeps it a corner mark.
    const last = count - 1;

    if (context.watermarkApplied && context.font !== null) {
      const colour = (this.options.watermarkColor ?? '#ffffff').replace('#', '');
      filters.push(
        `[v${last}]` +
          `drawtext=fontfile=${escapeFilterText(context.font)}:` +
          `text=${escapeFilterText(this.options.watermark ?? '')}:` +
          `fontcolor=0x${colour}:fontsize=${Math.max(18, Math.round(width / 30))}:` +
          'x=w-tw-24:y=h-th-24:box=1:boxcolor=0x000000@0.45[vmarked]',
      );
    }

    const concatInputs = context.durations
      .map((_, index) => (index === last && context.watermarkApplied ? '[vmarked]' : `[v${index}]`))
      .join('');

    filters.push(`${concatInputs}concat=n=${count}:v=1:a=0[vout]`);

    filters.push(`[${audioIndex}:a]apad[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
    args.push('-c:a', 'aac', '-b:a', '128k');

    // An explicit output duration, and `apad`, instead of `-shortest`.
    //
    // `-shortest` ends the mux at whichever stream runs out first, which is
    // right in principle and catastrophic in the common case: when the stills
    // and the narration are the SAME length - which is exactly what a 15s reel
    // with 15s narration is - ffmpeg can drop the audio stream entirely and
    // hand back a successful, silent, 15-second video.
    args.push('-t', (context.totalMs / 1_000).toFixed(3));

    if (this.options.burnSubtitles === true) {
      args.push('-vf', `subtitles=${escapeFilterText(context.srtPath)}`);
    } else {
      args.push('-map', `${srtIndex}:s`, '-c:s', 'mov_text');
    }

    args.push('-movflags', '+faststart', context.outputPath);

    return args;
  }

  private async invoke(args: string[]): Promise<void> {
    try {
      await run(this.options.ffmpegPath ?? 'ffmpeg', args, {
        timeout: this.options.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      // The tail of ffmpeg's stderr carries the failure; the head is the banner.
      const tail = stderr.split('\n').slice(-6).join('\n').trim();

      throw new ProviderError(
        `ffmpeg failed: ${tail.slice(0, 400)}`,
        // A missing file or a bad argument fails identically every time; ENOSPC
        // or a killed process does not, and that one is worth retrying.
        /No such file|Invalid argument|Unknown encoder|does not contain any stream|Invalid data found|moov atom not found|Permission denied/i.test(
          stderr,
        )
          ? 'PERMANENT'
          : 'TRANSIENT',
        { cause: error },
      );
    }
  }
}
