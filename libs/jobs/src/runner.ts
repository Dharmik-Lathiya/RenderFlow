import { and, eq, inArray, sql } from 'drizzle-orm';
import { nextJobStage, type GenerationKind, type JobStage } from '@renderflow/common';
import {
  ProviderError,
  type BrandContext,
  type ImageProvider,
  type RendererProvider,
  type TextProvider,
  type TtsProvider,
} from '@renderflow/ai';
import { capture, refund } from '@renderflow/credits';
import { generationJobs, jobCheckpoints, type Database, type DbTransaction } from '@renderflow/db';

import {
  START_STAGE_BY_KIND,
  TERMINAL_STAGE,
  isPipelineComplete,
  resumeStage,
  stagesFor,
} from './stage-machine';

/**
 * The job runner (PROJECT.md section 12 Phase 4: "Stage machine
 * PLAN->SCRIPT->IMAGE->VOICE->RENDER... Reserve on request, capture on success,
 * refund on failure").
 *
 * This is the code that turns a reserved job into media, and the code that
 * decides whether the user is charged.
 *
 * Two rules shape it:
 *
 *  1. **Credit settlement happens exactly once**, and only here. `capture` and
 *     `refund` are the only paths that move a reservation, and both are
 *     idempotent in `libs/credits`. A worker crash between "job finished" and
 *     "credits captured" therefore costs the user nothing: the retry finds a
 *     completed job and `capture` returns `{ captured: false }`.
 *
 *  2. **A stage is only skipped if its checkpoint exists.** Resume is derived
 *     from `job_checkpoints`, never from the job's `stage` column, so a job that
 *     crashed between the two writes still re-runs the stage rather than skipping
 *     it and producing an incomplete asset.
 */

export interface RunnerProviders {
  text: TextProvider;
  image: ImageProvider;
  tts: TtsProvider;
  renderer: RendererProvider;
}

/**
 * Storage, narrowed to what the runner needs.
 *
 * The mock providers return a key without writing anything, so the runner writes
 * a small placeholder object itself. That keeps `headObject` meaningful - the
 * confirm path in the asset flow depends on a real object being there.
 */
export interface RunnerStorage {
  putObject(input: { key: string; body: Uint8Array; contentType: string }): Promise<unknown>;
}

export interface JobRunDeps {
  db: Database;
  providers: RunnerProviders;
  storage: RunnerStorage;
  /** Brand voice for prompts. Treated as untrusted data downstream. */
  brand?: BrandContext;
  signal?: AbortSignal;
}

export type JobOutcome = 'COMPLETED' | 'FAILED' | 'ALREADY_SETTLED';

export interface JobRunResult {
  jobId: string;
  outcome: JobOutcome;
  /** Stages this invocation actually ran. Empty when it resumed a finished job. */
  stagesRun: JobStage[];
  error?: string;
}

/**
 * Runs a job to completion, or throws.
 *
 * Throwing rather than refunding on failure is deliberate: a `TRANSIENT` provider
 * error should be retried by the queue with the retry preset, and only the final
 * attempt should give the credits back. `failJob` is what the worker calls once
 * attempts are exhausted, or immediately for a `PERMANENT` error.
 */
export async function runJob(deps: JobRunDeps, jobId: string): Promise<JobRunResult> {
  const job = await loadJob(deps.db, jobId);

  if (job === null) {
    throw new Error(`job ${jobId} not found`);
  }

  if (job.refunded === 1) {
    // The credits are already back with the user. Running the work anyway would
    // produce a free asset and re-charge nothing, so it is simply not done.
    return { jobId, outcome: 'ALREADY_SETTLED', stagesRun: [] };
  }

  if (job.captured === 1 || job.status === 'COMPLETED') {
    return { jobId, outcome: 'ALREADY_SETTLED', stagesRun: [] };
  }

  const kind = job.kind as GenerationKind;
  const completed = await checkpointStages(deps.db, jobId);

  if (isPipelineComplete(kind, [...completed])) {
    // Every stage is already checkpointed: finish the job without redoing work.
    await settleSuccess(deps.db, jobId);
    return { jobId, outcome: 'COMPLETED', stagesRun: [] };
  }

  await markProcessing(deps.db, jobId);

  const stagesRun: JobStage[] = [];

  // Resume at the FIRST gap, then run everything from there to the end - not
  // "skip whatever happens to be checkpointed". A later artefact can depend on an
  // earlier one that was never produced, so skipping IMAGE while redoing SCRIPT
  // would stitch a reel from a stale frame and a fresh script. Skipping
  // individually is exactly the hole `resumeStage` exists to prevent.
  const from = resumeStage(kind, [...completed]);
  const pending = stagesFor(kind).slice(stagesFor(kind).indexOf(from));

  for (const stage of pending) {
    deps.signal?.throwIfAborted();

    const outputRef = await runStage(deps, { jobId, stage, kind, job });

    // Checkpoint written only after the artefact exists, so a crash mid-stage
    // re-runs the stage rather than recording work that never happened.
    await writeCheckpoint(deps.db, jobId, stage, outputRef);
    await advanceStage(deps.db, jobId, nextJobStage(stage) ?? TERMINAL_STAGE);
    stagesRun.push(stage);
  }

  await settleSuccess(deps.db, jobId);

  return { jobId, outcome: 'COMPLETED', stagesRun };
}

/**
 * Fails a job and returns the credits.
 *
 * Idempotent through `libs/credits.refund`: calling it twice, or racing with a
 * reaper, produces exactly one refund (PROJECT.md test C8).
 */
export async function failJob(
  db: Database,
  jobId: string,
  reason: string,
): Promise<{ refunded: boolean; amount: number }> {
  const result = await db.transaction((tx) => refund(tx, jobId, reason));

  if (result.refunded) {
    await db
      .update(generationJobs)
      .set({ status: 'FAILED', error: reason, finishedAt: new Date() })
      .where(eq(generationJobs.id, jobId));
  }

  return result;
}

/**
 * Runs a job and refunds it if anything fails.
 *
 * This is the single-attempt path: local development, and the path tests use. In
 * production the queue retries a `TRANSIENT` failure first, so the worker calls
 * `runJob` and only calls `failJob` when attempts run out. That difference is the
 * whole reason the two are separate.
 */
export async function processJob(deps: JobRunDeps, jobId: string): Promise<JobRunResult> {
  try {
    return await runJob(deps, jobId);
  } catch (error) {
    const message = describeError(error);
    const settled = await failJob(deps.db, jobId, message);

    return {
      jobId,
      outcome: settled.refunded ? 'FAILED' : 'ALREADY_SETTLED',
      stagesRun: [],
      error: message,
    };
  }
}

// --- stage execution -------------------------------------------------------

interface StageContext {
  jobId: string;
  stage: JobStage;
  kind: GenerationKind;
  job: JobRow;
}

/**
 * Runs one stage and returns the storage key it produced.
 *
 * Artefacts are written to storage before the checkpoint, so a checkpoint never
 * references something that does not exist.
 */
async function runStage(deps: JobRunDeps, ctx: StageContext): Promise<string> {
  const { providers, brand } = deps;
  const brandContext = brand ?? DEFAULT_BRAND;
  const payload = readPayload(ctx.job.payload);

  switch (ctx.stage) {
    case 'PLAN': {
      const goal = typeof payload.goal === 'string' ? payload.goal : 'Grow the brand';
      const days = typeof payload.days === 'number' ? payload.days : 7;
      const plan = await providers.text.plan({ goal, days, brand: brandContext });
      return writeText(deps, `generated/plan/${ctx.jobId}.json`, JSON.stringify(plan));
    }

    case 'SCRIPT': {
      const caption = await providers.text.caption({
        angle: typeof payload.angle === 'string' ? payload.angle : 'Today at the brand',
        brand: brandContext,
      });
      const scenes =
        ctx.kind === 'REEL' ? (typeof payload.scenes === 'number' ? payload.scenes : 5) : 1;
      const script = await providers.text.script({
        caption: caption.caption,
        scenes,
      });

      return writeText(
        deps,
        `generated/script/${ctx.jobId}.json`,
        JSON.stringify({ caption, script }),
      );
    }

    case 'IMAGE': {
      const count = typeof payload.images === 'number' ? payload.images : 1;
      const width = typeof payload.width === 'number' ? payload.width : 1080;
      const height = typeof payload.height === 'number' ? payload.height : 1080;
      const keys: string[] = [];

      for (let index = 0; index < count; index += 1) {
        const image = await providers.image.generate({
          prompt: typeof payload.prompt === 'string' ? payload.prompt : `${brandContext.name}`,
          index: index + 1,
          kind: ctx.kind,
          width,
          height,
        });
        await writeBytes(deps, image.storageKey, 'image/png', image.width, image.height);
        keys.push(image.storageKey);
      }

      return writeText(deps, `generated/images/${ctx.jobId}.json`, JSON.stringify(keys));
    }

    case 'VOICE': {
      const text =
        typeof payload.narration === 'string' ? payload.narration : 'RenderFlow demo reel';
      const audio = await providers.tts.speak({ text, voice: 'en-GB' });
      await writeBytes(deps, audio.storageKey, 'audio/mpeg', 0, 0, audio.durationMs);
      return audio.storageKey;
    }

    case 'RENDER': {
      const sceneCount = typeof payload.scenes === 'number' ? payload.scenes : 5;
      const scenes = Array.from({ length: sceneCount }, (_, i) => ({
        imageKey: `generated/frame-${i + 1}.png`,
        audioKey: `generated/voice.mp3`,
      }));
      const rendered = await providers.renderer.render({
        scenes,
        width: typeof payload.width === 'number' ? payload.width : 1080,
        height: typeof payload.height === 'number' ? payload.height : 1920,
      });
      await writeBytes(deps, rendered.storageKey, 'video/mp4', 0, 0, rendered.durationMs);
      return rendered.storageKey;
    }

    case 'DONE':
      // Not a unit of work. A job that reaches here has already settled.
      return `generated/done/${ctx.jobId}`;
  }
}

// --- persistence -----------------------------------------------------------

interface JobRow {
  id: string;
  userId: string;
  kind: string;
  status: string;
  stage: string;
  creditsReserved: number;
  refunded: number;
  captured: number;
  payload: Record<string, unknown>;
}

async function loadJob(db: Database, jobId: string): Promise<JobRow | null> {
  const rows = await db
    .select({
      id: generationJobs.id,
      userId: generationJobs.userId,
      kind: generationJobs.kind,
      status: generationJobs.status,
      stage: generationJobs.stage,
      creditsReserved: generationJobs.creditsReserved,
      refunded: generationJobs.refunded,
      captured: generationJobs.captured,
      payload: generationJobs.payload,
    })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  return rows[0] ?? null;
}

async function checkpointStages(db: Database, jobId: string): Promise<Set<JobStage>> {
  const rows = await db
    .select({ stage: jobCheckpoints.stage })
    .from(jobCheckpoints)
    .where(eq(jobCheckpoints.jobId, jobId));

  return new Set(rows.map((row) => row.stage));
}

/**
 * Writes the checkpoint.
 *
 * An upsert, not `ON CONFLICT DO NOTHING`: when a stage is re-run after a resume,
 * the new artefact may be at a different key, and leaving the stale reference
 * would point downstream at media that no longer exists.
 */
async function writeCheckpoint(
  db: Database,
  jobId: string,
  stage: JobStage,
  outputRef: string,
): Promise<void> {
  await db
    .insert(jobCheckpoints)
    .values({ jobId, stage, outputRef })
    .onConflictDoUpdate({
      target: [jobCheckpoints.jobId, jobCheckpoints.stage],
      set: { outputRef },
    });
}

/** Claim. `WHERE status = 'PENDING'` so only one worker can win. */
async function markProcessing(db: Database, jobId: string): Promise<void> {
  await db
    .update(generationJobs)
    .set({ status: 'PROCESSING', updatedAt: new Date() })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, 'PENDING')));
}

async function advanceStage(db: Database, jobId: string, stage: JobStage): Promise<void> {
  await db
    .update(generationJobs)
    .set({ stage, updatedAt: new Date() })
    .where(eq(generationJobs.id, jobId));
}

/**
 * Finishes a job and captures the credits in one transaction.
 *
 * The job status and the credit movement are settled together so a crash cannot
 * leave a COMPLETED job whose credits were never charged - which would be a
 * silently free generation.
 */
async function settleSuccess(db: Database, jobId: string): Promise<void> {
  await db.transaction(async (tx: DbTransaction) => {
    const result = await capture(tx, jobId);
    if (result.captured) {
      await tx
        .update(generationJobs)
        .set({ status: 'COMPLETED', stage: TERMINAL_STAGE, finishedAt: new Date() })
        .where(eq(generationJobs.id, jobId));
    }
  });
}

// --- helpers ---------------------------------------------------------------

const DEFAULT_BRAND: BrandContext = {
  name: 'RenderFlow',
  colors: [],
  languages: ['en'],
};

/** Untrusted payload from the request; read defensively, never spread. */
function readPayload(payload: Record<string, unknown> | null): Record<string, unknown> {
  return payload ?? {};
}

async function writeBytes(
  deps: JobRunDeps,
  key: string,
  contentType: string,
  width: number,
  height: number,
  durationMs = 0,
): Promise<void> {
  // A deterministic placeholder, so `headObject` has something real to find and
  // an asset row can be confirmed.
  const body = new TextEncoder().encode(
    JSON.stringify({ key, contentType, width, height, durationMs, bytes: 'mock' }),
  );
  await deps.storage.putObject({ key, body, contentType });
}

async function writeText(deps: JobRunDeps, key: string, text: string): Promise<string> {
  await deps.storage.putObject({
    key,
    body: new TextEncoder().encode(text),
    contentType: 'application/json',
  });
  return key;
}

/**
 * Turns any thrown value into something safe to store on the job row.
 *
 * Provider errors are already safe; anything else is summarised rather than
 * stringified, because an arbitrary error can contain a prompt or a token and
 * this text is returned by the API.
 */
export function describeError(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.classification}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return 'unknown error';
}

export { START_STAGE_BY_KIND, inArray, sql };
