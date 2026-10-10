import { JOB_STAGES, nextJobStage, type GenerationKind, type JobStage } from '@renderflow/common';

/**
 * The generation stage machine (PROJECT.md section 7).
 *
 * Deliberately pure and dependency-free. The interesting rules - which stage
 * follows which, where a job starts for a given kind, which transitions are
 * legal - are easier to get wrong silently than almost anything else in the
 * codebase, and they cost nothing to test exhaustively here.
 *
 * The runner that *executes* stages lives in `runJob`, which needs a database.
 */

export const STAGES: readonly JobStage[] = JOB_STAGES;

/** The stage after which the job is finished and credits may be captured. */
export const TERMINAL_STAGE: JobStage = 'DONE';

/** Legal status transitions (PROJECT.md section 7). */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PENDING: ['PROCESSING', 'FAILED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (JOB_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Which stages each kind of job actually runs.
 *
 * Declared explicitly rather than derived as "everything from the start stage to
 * the end". The derived version looked tidier and was wrong: it made a POSTER run
 * VOICE and RENDER, so every single image would have been narrated and "stitched"
 * into a one-shot video. A slice hides that class of mistake; a table states it.
 *
 * `PLAN`   - decide what to post.
 * `SCRIPT` - write the words (caption, hashtags, narration).
 * `IMAGE`  - produce the still(s).
 * `VOICE`  - synthesise narration audio.
 * `RENDER` - stitch images and audio into a video.
 */
export const STAGES_BY_KIND: Readonly<Record<GenerationKind, readonly JobStage[]>> = {
  CONTENT_PLAN: ['PLAN'],
  CAPTION: ['SCRIPT'],
  TRANSLATION: ['SCRIPT'],
  POSTER: ['IMAGE'],
  REGENERATE_SCENE: ['IMAGE'],
  CAROUSEL: ['IMAGE'],
  REEL: ['PLAN', 'SCRIPT', 'IMAGE', 'VOICE', 'RENDER'],
};

/**
 * Where a job of `kind` starts: the first stage it runs.
 *
 * A REEL begins at PLAN because it needs a script, images and audio before it can
 * render. A single POSTER begins at IMAGE because the caption is the whole job.
 */
export const START_STAGE_BY_KIND: Readonly<Record<GenerationKind, JobStage>> = Object.fromEntries(
  (Object.keys(STAGES_BY_KIND) as GenerationKind[]).map((kind) => [
    kind,
    STAGES_BY_KIND[kind][0] as JobStage,
  ]),
) as Record<GenerationKind, JobStage>;

/** Stages a job of `kind` runs, in order. Never includes the DONE marker. */
export function stagesFor(kind: GenerationKind): JobStage[] {
  return [...(STAGES_BY_KIND[kind] ?? [])];
}

/** Every stage from the job's start through DONE. */
export function fullStageSequence(kind: GenerationKind): JobStage[] {
  return [...stagesFor(kind), TERMINAL_STAGE];
}

/**
 * The stage to resume from, given the stages already checkpointed.
 *
 * The first stage with no checkpoint. Anything after it has to be redone, because
 * a later artefact may depend on an earlier one that was never produced.
 */
export function resumeStage(kind: GenerationKind, completed: readonly JobStage[]): JobStage {
  const done = new Set(completed);
  return stagesFor(kind).find((stage) => !done.has(stage)) ?? 'DONE';
}

/**
 * True when every stage the job needs has a checkpoint.
 *
 * Computed from the stages the job actually runs, not from "any five rows", so a
 * stale checkpoint from a previous attempt at a different stage cannot make a job
 * look finished.
 */
export function isPipelineComplete(kind: GenerationKind, completed: readonly JobStage[]): boolean {
  const done = new Set(completed);
  return stagesFor(kind).every((stage) => done.has(stage));
}

/** True when `stage` is one this job kind runs at all. */
export function stageApplies(kind: GenerationKind, stage: JobStage): boolean {
  return stagesFor(kind).includes(stage);
}

/** Stages a POSTER would run, as a guard against the mapping above drifting. */
export function assertStageOrder(): void {
  for (let i = 1; i < STAGES.length; i += 1) {
    const previous = STAGES[i - 1];
    const current = STAGES[i];
    if (previous === undefined || current === undefined) {
      throw new Error('stage list is malformed');
    }
    if (nextJobStage(previous) !== current) {
      throw new Error(`stage order disagrees with nextJobStage at ${previous}`);
    }
  }
}
