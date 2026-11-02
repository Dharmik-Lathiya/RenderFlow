import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  ProviderError,
  type FestivalPosterInput,
  type FestivalReelInput,
  type RenderResult,
  type RendererProvider,
} from './providers';

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

/** `#rrggbb`/`#rrggbbaa` to ffmpeg's `0xrrggbb[@alpha]` form. */
export function ffmpegColor(value: string): string {
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(trimmed)) {
    // A malformed colour from a template descriptor must not reach the filter
    // graph, where it would either fail the render or be parsed as something else.
    throw new ProviderError(`invalid festival colour: ${value}`, 'PERMANENT');
  }

  if (trimmed.length === 8) {
    return `0x${trimmed.slice(0, 6)}@${(Number.parseInt(trimmed.slice(6), 16) / 255).toFixed(3)}`;
  }

  return `0x${trimmed}`;
}

/**
 * Splits a poster line into at most three lines that fit the poster width.
 *
 * `drawtext` has no wrapping of its own. Without this, a 60-character offer at
 * 48px runs off both edges of a 1080px poster - which still renders "successfully"
 * and is only noticed by the user after the credits are captured.
 */
export function wrapPosterText(text: string, fontSize: number, width: number): string[] {
  const budget = Math.max(8, Math.floor((width * 0.86) / (fontSize * 0.56)));
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const lines: string[] = [];

  for (const word of words) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && previous.length + 1 + word.length <= budget) {
      lines[lines.length - 1] = `${previous} ${word}`;
    } else {
      lines.push(word);
    }
  }

  // Longer copy is clipped, not shrunk: the LLM schema already caps the slot at
  // maxChars, and silently changing the font size would make the hierarchy
  // depend on how talkative the model was.
  return lines.slice(0, 3);
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

  async renderFestivalPoster(input: FestivalPosterInput): Promise<RenderResult> {
    const dir = await mkdtemp(join(tmpdir(), 'renderflow-festival-'));
    const outputPath = join(dir, 'poster.png');

    try {
      await this.renderFestivalPosterFile(input, outputPath, dir);

      const key = `generated/festival/${input.jobId}/poster-${input.width}x${input.height}.png`;
      await this.options.storage.putObject({
        key,
        body: new Uint8Array(await readFile(outputPath)),
        contentType: 'image/png',
        metadata: { width: String(input.width), height: String(input.height) },
      });

      return { storageKey: key, durationMs: 0 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async renderFestivalReel(input: FestivalReelInput): Promise<RenderResult> {
    const dir = await mkdtemp(join(tmpdir(), 'renderflow-festival-reel-'));
    const posterPath = join(dir, 'poster.png');
    const durationSeconds = Math.max(1, input.durationMs / 1_000);

    try {
      if (input.posterKey !== undefined && input.posterKey !== null && input.posterKey !== '') {
        await writeFile(posterPath, await this.options.storage.getObject(input.posterKey));
      } else {
        await this.renderFestivalPosterFile(input, posterPath, dir);
      }

      const font = await findFont(this.options.fontPath);
      const args: string[] = [
        '-y',
        '-loop',
        '1',
        '-framerate',
        '30',
        '-t',
        durationSeconds.toFixed(3),
        '-i',
        posterPath,
      ];

      let audioPath: string | null = null;
      if (input.audioKey !== undefined && input.audioKey !== null && input.audioKey !== '') {
        audioPath = join(dir, 'audio.mp3');
        await writeFile(audioPath, await this.options.storage.getObject(input.audioKey));
        args.push('-i', audioPath);
      }

      const filters: string[] = [
        `[0:v]scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,` +
          `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=${ffmpegColor(input.background)},` +
          `setsar=1,zoompan=z='min(zoom+0.0004,1.06)':d=1:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${input.width}x${input.height}:fps=30`,
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, durationSeconds - 0.4).toFixed(3)}:d=0.4`,
      ];

      if (font !== null && input.brandName.trim() !== '') {
        filters.push(
          `drawtext=fontfile=${escapeFilterText(font)}:` +
            `text=${escapeFilterText(input.brandName)}:` +
            `fontcolor=white:fontsize=${Math.max(18, Math.round(input.width / 32))}:` +
            `x=${Math.round(input.width * 0.06)}:y=h-th-${Math.round(input.height * 0.06)}:` +
            `box=1:boxcolor=black@0.35:boxborderw=12:` +
            `alpha='if(lt(t,0.6),0,min(1,(t-0.6)/0.6))'`,
        );
      }

      args.push(
        '-vf',
        filters.join(','),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
      );

      if (audioPath !== null) {
        args.push(
          '-filter_complex',
          `[1:a]apad,atrim=0:${durationSeconds.toFixed(3)}[aout]`,
          '-map',
          '0:v',
          '-map',
          '[aout]',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
        );
      }

      args.push('-t', durationSeconds.toFixed(3), '-movflags', '+faststart', join(dir, 'reel.mp4'));
      await this.invoke(args);

      const key = `generated/festival/${input.jobId}/reel-${input.width}x${input.height}.mp4`;
      await this.options.storage.putObject({
        key,
        body: new Uint8Array(await readFile(join(dir, 'reel.mp4'))),
        contentType: 'video/mp4',
        metadata: {
          width: String(input.width),
          height: String(input.height),
          durationMs: String(input.durationMs),
        },
      });

      return { storageKey: key, durationMs: input.durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Draws one poster to `outputPath`.
   *
   * Split out of `renderFestivalPoster` so the reel can reuse it without a round
   * trip through object storage when no poster was rendered beforehand.
   */
  private async renderFestivalPosterFile(
    input: FestivalPosterInput,
    outputPath: string,
    dir: string,
  ): Promise<void> {
    const font = await findFont(this.options.fontPath);
    if (input.lines.length > 0 && font === null) {
      // A poster with no copy is not the product the user paid for. Failing here
      // refunds instead of capturing credits for a blank background.
      throw new ProviderError(
        'no font available for festival poster text; install fonts-dejavu-core or set FESTIVAL_FONT_PATH',
        'PERMANENT',
      );
    }

    const args: string[] = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${ffmpegColor(input.background)}:s=${input.width}x${input.height}:d=1`,
    ];

    let logoPath: string | null = null;
    if (input.logoKey !== undefined && input.logoKey !== null && input.logoKey !== '') {
      logoPath = join(dir, 'logo.bin');
      await writeFile(logoPath, await this.options.storage.getObject(input.logoKey));
      args.push('-i', logoPath);
    }

    const filters: string[] = [];

    for (const line of input.lines) {
      if (font === null) {
        continue;
      }

      const chunks = wrapPosterText(line.text, line.fontSize, input.width);
      const lineHeight = Math.round(line.fontSize * 1.18);
      const blockHeight = chunks.length * lineHeight;
      const baseY =
        line.position === 'top-center'
          ? Math.round(input.height * 0.12)
          : line.position === 'bottom-center'
            ? Math.round(input.height * 0.88) - blockHeight
            : Math.round((input.height - blockHeight) / 2);

      for (const [index, chunk] of chunks.entries()) {
        filters.push(
          `drawtext=fontfile=${escapeFilterText(font)}:` +
            `text=${escapeFilterText(chunk)}:` +
            `fontcolor=${ffmpegColor(line.color ?? '#ffffff')}:fontsize=${line.fontSize}:` +
            `x=(w-text_w)/2:y=${baseY + index * lineHeight}:` +
            'shadowcolor=black@0.45:shadowx=2:shadowy=2',
        );
      }
    }

    // A thin accent rule anchors the template's palette even when the copy is
    // short; it is also the only visible element if a template has no text slots.
    filters.push(`drawbox=x=0:y=h-14:w=iw:h=14:color=${ffmpegColor(input.accent)}:t=fill`);

    if (logoPath !== null) {
      const logoSize = Math.round(input.width * 0.14);
      filters.push(`[1:v]scale=${logoSize}:-1[logo]`, `[0:v][logo]overlay=x=w-ow-32:y=32[vout]`);
      args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    } else {
      args.push('-vf', filters.join(','));
    }

    args.push('-frames:v', '1', outputPath);
    await this.invoke(args);
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
