import { and, eq, sql } from 'drizzle-orm';
import {
  festivalJobPayloadSchema,
  festivalScriptSchema,
  isFestivalKind,
  type FestivalJobPayload,
  type GenerationKind,
  type JobStage,
} from '@renderflow/common';
import {
  ProviderError,
  type BrandContext,
  type ImageProvider,
  type RendererProvider,
  type TextProvider,
  type TtsProvider,
} from '@renderflow/ai';
import { capture, refund } from '@renderflow/credits';
import {
  assets,
  brands,
  generationJobs,
  jobCheckpoints,
  outboxEvents,
  posts,
  type Database,
  type DbTransaction,
} from '@renderflow/db';

import { acquireLease, releaseLease, type LeaseConfig } from './lease';
import { TERMINAL_STAGE, isPipelineComplete, resumeStage, stagesFor } from './stage-machine';

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
  /**
   * Reads an artefact back. Festival IMAGE/RENDER need the copy the previous
   * stage wrote, and a checkpoint key is useless if nobody can dereference it.
   */
  getObject(key: string): Promise<Uint8Array>;
  /**
   * Optional because several test doubles predate it. When present, the runner
   * no longer overwrites a provider's real bytes with its placeholder.
   */
  headObject?(key: string): Promise<{ sizeBytes?: number } | null>;
}

export interface JobRunDeps {
  db: Database;
  providers: RunnerProviders;
  storage: RunnerStorage;
  /**
   * The stages this worker owns. Omit it and the runner runs the whole pipeline,
   * which is what tests and a single-process local setup want. Production
   * workers pass their queue's stages so a reel genuinely crosses from
   * content-worker to media-worker.
   */
  stages?: readonly JobStage[];
  /**
   * The lease to hold while running.
   *
   * Omit it and the runner claims nothing, which is what tests and a
   * single-process local setup want. A production worker must pass it: without a
   * lease, a killed worker leaves a PROCESSING job that nothing can ever reclaim.
   */
  lease?: { workerId: string; config: LeaseConfig };
  /** Brand voice for prompts. Treated as untrusted data downstream. */
  brand?: BrandContext;
  signal?: AbortSignal;
}

export type JobOutcome = 'COMPLETED' | 'FAILED' | 'ALREADY_SETTLED' | 'PARTIAL' | 'HANDED_OFF';

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
    await settleSuccess(deps, jobId);
    return { jobId, outcome: 'COMPLETED', stagesRun: [] };
  }

  // Resume at the FIRST gap, then run everything from there to the end - not
  // "skip whatever happens to be checkpointed". A later artefact can depend on an
  // earlier one that was never produced, so skipping IMAGE while redoing SCRIPT
  // would stitch a reel from a stale frame and a fresh script. Skipping
  // individually is exactly the hole `resumeStage` exists to prevent.
  const from = resumeStage(kind, [...completed]);
  const pipeline = stagesFor(kind);
  const pending = pipeline.slice(pipeline.indexOf(from));

  // Only the stages this worker owns. A content worker runs PLAN and SCRIPT and
  // stops, leaving IMAGE/VOICE/RENDER to the media worker; the
  // `job.stage_completed` events it writes are what hand the job over. Without
  // this filter a "content" worker would quietly become the only worker and
  // media-worker would be dead code that looked alive.
  const owned =
    deps.stages === undefined ? pending : pending.filter((stage) => deps.stages?.includes(stage));

  // And it may only start at the gap itself. If the first missing stage belongs
  // to another worker, this one has nothing to do yet: a media worker that ran
  // RENDER while PLAN and SCRIPT were still missing would produce a reel from a
  // script that does not exist, which is the same stale-artefact hole
  // `resumeStage` prevents, one process boundary further out.
  //
  // Returning without claiming the job also matters: a worker that marks it
  // PROCESSING and does nothing would leave it looking like progress was made.
  if (deps.stages !== undefined && !deps.stages.includes(from)) {
    return { jobId, outcome: 'HANDED_OFF', stagesRun: [] };
  }

  // Take the lease before running anything, and only now - after the cheap
  // checks. A worker that cannot get the lease must return without touching the
  // job: someone else is working on it right now, and "someone else" includes a
  // worker that is alive and merely slow.
  //
  // Claiming before these checks would bump the attempt counter on every job
  // this worker has no business running, so a healthy two-worker setup would
  // exhaust a three-attempt budget in a minute and start refunding jobs that
  // were never actually broken.
  const lease =
    deps.lease === undefined
      ? null
      : await acquireLease(deps.db, jobId, deps.lease.workerId, deps.lease.config);

  if (deps.lease !== undefined && lease === null) {
    return { jobId, outcome: 'HANDED_OFF', stagesRun: [] };
  }

  const stagesRun: JobStage[] = [];

  try {
    for (const stage of owned) {
      deps.signal?.throwIfAborted();

      const outputRef = await runStage(deps, { jobId, stage, kind, job });

      // The artefact, the checkpoint and the hand-off event are written together,
      // in one transaction. An event pointing at a checkpoint that does not exist
      // would hand the next worker a job it cannot resume; a checkpoint with no
      // event would strand the job with nobody left to run it.
      await recordStage(deps.db, { jobId, stage, kind, outputRef });
      stagesRun.push(stage);
    }

    // Capture only when the WHOLE pipeline is done. A content worker that
    // finished SCRIPT has done a third of the work; charging the user for the
    // reel they did not get is exactly what this condition prevents.
    const finished = await checkpointStages(deps.db, jobId);

    if (isPipelineComplete(kind, [...finished])) {
      await settleSuccess(deps, jobId);
      return { jobId, outcome: 'COMPLETED', stagesRun };
    }

    return {
      jobId,
      outcome: stagesRun.length === 0 ? 'HANDED_OFF' : 'PARTIAL',
      stagesRun,
    };
  } finally {
    // Release the lease whether we finished or threw. Leaving it held would make
    // the reaper wait out the whole lease period before anyone could pick the job
    // up - and for a completed job, would leave the row claiming a worker that
    // does not exist.
    //
    // Not on the HANDED_OFF path above: the lease was never taken there, and
    // releasing it would clear a lease belonging to whichever worker *does* own
    // the job.
    if (lease !== null) {
      await releaseLease(deps.db, jobId, deps.lease?.workerId ?? '');
    }
  }
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
  const rows = await db
    .select({ postId: generationJobs.postId, kind: generationJobs.kind })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  const result = await db.transaction((tx) => refund(tx, jobId, reason));

  if (result.refunded) {
    await db.transaction(async (tx: DbTransaction) => {
      await tx
        .update(generationJobs)
        .set({ status: 'FAILED', error: reason, finishedAt: new Date() })
        .where(eq(generationJobs.id, jobId));

      const job = rows[0];
      if (job !== undefined && job.postId !== null && isFestivalKind(job.kind)) {
        // The post was created GENERATING so the campaign dashboard can show the
        // attempt. Refunding without closing it would leave a post that spins
        // forever, so a failed festival generation moves it to FAILED.
        await tx
          .update(posts)
          .set({ status: 'FAILED', updatedAt: new Date() })
          .where(and(eq(posts.id, job.postId), eq(posts.status, 'GENERATING')));
      }
    });
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
      if (isFestivalKind(ctx.kind)) {
        const festival = parseFestivalPayload(payload);
        const plan = await providers.text.plan({
          goal: `${festival.occasionName}: ${festival.offerText}`,
          days: 1,
          brand: festivalBrand(deps, festival),
        });
        return writeText(deps, `generated/festival/${ctx.jobId}/plan.json`, JSON.stringify(plan));
      }

      const goal = typeof payload.goal === 'string' ? payload.goal : 'Grow the brand';
      const days = typeof payload.days === 'number' ? payload.days : 7;
      const plan = await providers.text.plan({ goal, days, brand: brandContext });
      return writeText(deps, `generated/plan/${ctx.jobId}.json`, JSON.stringify(plan));
    }

    case 'SCRIPT': {
      if (isFestivalKind(ctx.kind)) {
        const festival = parseFestivalPayload(payload);
        const copy = await providers.text.festivalCopy({
          occasionId: festival.occasionId,
          occasionName: festival.occasionName,
          template: festival.template,
          offerText: festival.offerText,
          ctaText: festival.ctaText,
          language: festival.language,
          brand: festivalBrand(deps, festival),
        });

        return writeText(
          deps,
          `generated/festival/${ctx.jobId}/script.json`,
          JSON.stringify(festivalScriptSchema.parse(copy)),
        );
      }

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
      if (isFestivalKind(ctx.kind)) {
        const festival = parseFestivalPayload(payload);
        const copy = await readFestivalScript(deps, ctx.jobId);
        const lines = posterLines(festival, copy);
        const { width, height } = festival.template.dimensions;

        const poster = await providers.renderer.renderFestivalPoster({
          jobId: ctx.jobId,
          width,
          height,
          background: festival.template.colorScheme.background,
          primary: festival.template.colorScheme.primary,
          accent: festival.template.colorScheme.accent,
          lines,
        });

        await writeBytesIfMissing(deps, poster.storageKey, 'image/png', width, height);
        return poster.storageKey;
      }

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
      if (ctx.kind === 'FESTIVAL_REEL') {
        const festival = parseFestivalPayload(payload);
        const posterKey = await checkpointRef(deps.db, ctx.jobId, 'IMAGE');
        if (posterKey === null) {
          throw new ProviderError('festival reel has no poster checkpoint', 'PERMANENT');
        }

        const { width, height } = festival.template.dimensions;
        const rendered = await providers.renderer.renderFestivalReel({
          jobId: ctx.jobId,
          width,
          height,
          background: festival.template.colorScheme.background,
          primary: festival.template.colorScheme.primary,
          accent: festival.template.colorScheme.accent,
          lines: [],
          posterKey,
          audioKey: festival.template.audioTrack,
          durationMs: (festival.template.reelDurationSeconds ?? 15) * 1_000,
          brandName: festivalBrand(deps, festival).name,
        });

        await writeBytesIfMissing(
          deps,
          rendered.storageKey,
          'video/mp4',
          width,
          height,
          rendered.durationMs,
        );
        return rendered.storageKey;
      }

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
 * Records a finished stage: checkpoint, job stage pointer and the hand-off
 * event, in one transaction.
 *
 * Three writes that must not come apart:
 *
 *  - The checkpoint is an UPSERT, not `ON CONFLICT DO NOTHING`. When a stage is
 *    re-run after a resume the new artefact may sit at a different key, and
 *    leaving the stale reference would point downstream at media that no longer
 *    exists.
 *  - `job.stage_completed` is what routes the job to the worker owning the NEXT
 *    stage. Without it the job stops here, halfway, with credits reserved and
 *    nothing left to finish it.
 *  - The `aggregateId` is the job id, so the relay's deterministic job id
 *    (`generation-<jobId>`) collapses the repeated events a retry produces into a
 *    single enqueue.
 */
async function recordStage(
  db: Database,
  input: { jobId: string; stage: JobStage; kind: GenerationKind; outputRef: string },
): Promise<void> {
  const sequence = stagesFor(input.kind);
  const index = sequence.indexOf(input.stage);
  const next = index >= 0 && index + 1 < sequence.length ? sequence[index + 1] : TERMINAL_STAGE;

  await db.transaction(async (tx: DbTransaction) => {
    await tx
      .insert(jobCheckpoints)
      .values({ jobId: input.jobId, stage: input.stage, outputRef: input.outputRef })
      .onConflictDoUpdate({
        target: [jobCheckpoints.jobId, jobCheckpoints.stage],
        set: { outputRef: input.outputRef },
      });

    await tx
      .update(generationJobs)
      .set({ stage: next, updatedAt: new Date() })
      .where(eq(generationJobs.id, input.jobId));

    await tx.insert(outboxEvents).values({
      aggregateType: 'JOB',
      aggregateId: input.jobId,
      eventType: 'job.stage_completed',
      // The stage is part of the identity: five stages of one job are five
      // events, not one event five times.
      dedupeKey: `JOB:${input.jobId}:job.stage_completed:${input.stage}`,
      payload: {
        eventType: 'job.stage_completed',
        jobId: input.jobId,
        stage: input.stage,
        outputRef: input.outputRef,
      },
    });
  });
}

/**
 * Finishes a job and captures the credits in one transaction.
 *
 * The job status and the credit movement are settled together so a crash cannot
 * leave a COMPLETED job whose credits were never charged - which would be a
 * silently free generation.
 *
 * Festival artefacts are read and measured BEFORE the transaction opens. Object
 * storage is a network dependency, and holding a database transaction open while
 * talking to it is how a slow S3 turns into a pool exhaustion incident
 * (AGENTS.md section 6).
 */
async function settleSuccess(deps: JobRunDeps, jobId: string): Promise<void> {
  const festival = await prepareFestivalSettlement(deps, jobId);

  await deps.db.transaction(async (tx: DbTransaction) => {
    const result = await capture(tx, jobId);
    if (!result.captured) {
      return;
    }

    await tx
      .update(generationJobs)
      .set({ status: 'COMPLETED', stage: TERMINAL_STAGE, finishedAt: new Date() })
      .where(eq(generationJobs.id, jobId));

    if (festival !== null) {
      await finaliseFestivalPost(tx, festival);
    }
  });
}

interface FestivalSettlement {
  jobId: string;
  postId: string;
  script: { slots: Record<string, string>; caption: string; hashtags: string[] };
  template: FestivalJobPayload['template'];
  occasionId: string;
  poster: { key: string; sizeBytes: number };
  reel: { key: string; sizeBytes: number } | null;
}

/**
 * Loads the material a festival settlement needs, outside any transaction.
 *
 * Returns null for every other kind, which is what keeps the non-festival path
 * exactly as cheap as it was.
 */
async function prepareFestivalSettlement(
  deps: JobRunDeps,
  jobId: string,
): Promise<FestivalSettlement | null> {
  const rows = await deps.db
    .select({
      postId: generationJobs.postId,
      kind: generationJobs.kind,
      payload: generationJobs.payload,
    })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  const job = rows[0];
  if (job === undefined || job.postId === null || !isFestivalKind(job.kind)) {
    return null;
  }
  const kind = job.kind;

  const festival = parseFestivalPayload(readPayload(job.payload));
  const script = await readFestivalScript(deps, jobId);
  const posterKey = await checkpointRef(deps.db, jobId, 'IMAGE');
  if (posterKey === null) {
    throw new ProviderError('festival job finished without a poster checkpoint', 'PERMANENT');
  }

  const poster = await storageSize(deps, posterKey);
  const reelKey = kind === 'FESTIVAL_REEL' ? await checkpointRef(deps.db, jobId, 'RENDER') : null;
  const reel =
    reelKey === null
      ? null
      : { key: reelKey, sizeBytes: (await storageSize(deps, reelKey)).sizeBytes };

  return {
    jobId,
    postId: job.postId,
    script,
    template: festival.template,
    occasionId: festival.occasionId,
    poster,
    reel,
  };
}

/**
 * Turns the finished generation into what the campaign dashboard shows.
 *
 * The post already exists (the API created it with the reservation), so this is
 * the transition from GENERATING to READY plus the two asset rows. It runs in the
 * capture transaction: a captured job with no visible output would charge the
 * user for something they cannot find.
 */
async function finaliseFestivalPost(
  tx: DbTransaction,
  settlement: FestivalSettlement,
): Promise<void> {
  const rows = await tx
    .select({ workspaceId: brands.workspaceId, version: posts.version })
    .from(posts)
    .innerJoin(brands, eq(brands.id, posts.brandId))
    .where(eq(posts.id, settlement.postId))
    .limit(1);

  const post = rows[0];
  if (post === undefined) {
    // The post was deleted while its generation ran. The credits are still
    // captured (the work was done), but there is nothing left to attach it to.
    return;
  }

  await tx
    .update(posts)
    .set({
      caption: settlement.script.caption,
      hashtags: settlement.script.hashtags.join(' '),
      status: 'READY',
      version: sql`${posts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, settlement.postId));

  const { width, height } = settlement.template.dimensions;
  await tx
    .insert(assets)
    .values({
      postId: settlement.postId,
      workspaceId: post.workspaceId,
      type: 'IMAGE',
      storageKey: settlement.poster.key,
      mime: 'image/png',
      sizeBytes: settlement.poster.sizeBytes,
      width,
      height,
      meta: {
        source: 'festival',
        jobId: settlement.jobId,
        occasionId: settlement.occasionId,
        templateId: settlement.template.id,
      },
    })
    .onConflictDoNothing({ target: assets.storageKey });

  if (settlement.reel !== null) {
    await tx
      .insert(assets)
      .values({
        postId: settlement.postId,
        workspaceId: post.workspaceId,
        type: 'VIDEO',
        storageKey: settlement.reel.key,
        mime: 'video/mp4',
        sizeBytes: settlement.reel.sizeBytes,
        width,
        height,
        durationMs: (settlement.template.reelDurationSeconds ?? 15) * 1_000,
        meta: {
          source: 'festival',
          jobId: settlement.jobId,
          occasionId: settlement.occasionId,
          templateId: settlement.template.id,
        },
      })
      .onConflictDoNothing({ target: assets.storageKey });
  }
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

function parseFestivalPayload(payload: Record<string, unknown>): FestivalJobPayload {
  const parsed = festivalJobPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderError(
      `invalid festival payload: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      'PERMANENT',
    );
  }
  return parsed.data;
}

function festivalBrand(deps: JobRunDeps, festival: FestivalJobPayload): BrandContext {
  const snapshot = festival.brand;
  if (snapshot === undefined) {
    return deps.brand ?? DEFAULT_BRAND;
  }

  return {
    name: snapshot.name,
    industry: snapshot.industry ?? null,
    tone: snapshot.tone ?? null,
    audience: snapshot.audience ?? null,
    colors: snapshot.colors,
    languages: snapshot.languages,
  };
}

function posterLines(
  festival: FestivalJobPayload,
  script: { slots: Record<string, string> },
): Array<{
  text: string;
  fontSize: number;
  position: 'top-center' | 'center' | 'bottom-center';
  color: string;
}> {
  return festival.template.slots
    .filter((slot) => slot.type === 'text')
    .map((slot) => ({
      text: (script.slots[slot.id] ?? '').trim(),
      fontSize: slot.fontSize ?? 48,
      position: slot.position,
      color:
        slot.id === 'cta'
          ? festival.template.colorScheme.accent
          : slot.id === 'headline'
            ? festival.template.colorScheme.primary
            : '#ffffff',
    }))
    .filter((line) => line.text !== '');
}

async function checkpointRef(
  db: Database | DbTransaction,
  jobId: string,
  stage: JobStage,
): Promise<string | null> {
  const rows = await db
    .select({ outputRef: jobCheckpoints.outputRef })
    .from(jobCheckpoints)
    .where(and(eq(jobCheckpoints.jobId, jobId), eq(jobCheckpoints.stage, stage)))
    .limit(1);
  return rows[0]?.outputRef ?? null;
}

async function readFestivalScript(
  deps: JobRunDeps,
  jobId: string,
): Promise<{ slots: Record<string, string>; caption: string; hashtags: string[] }> {
  const key = await checkpointRef(deps.db, jobId, 'SCRIPT');
  if (key === null) {
    throw new ProviderError('festival job has no SCRIPT checkpoint', 'PERMANENT');
  }

  const bytes = await deps.storage.getObject(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderError('festival SCRIPT checkpoint is not valid JSON', 'PERMANENT');
  }

  const script = festivalScriptSchema.safeParse(parsed);
  if (!script.success) {
    throw new ProviderError('festival SCRIPT checkpoint has the wrong shape', 'PERMANENT');
  }
  return script.data;
}

async function storageSize(
  deps: JobRunDeps,
  key: string,
): Promise<{ key: string; sizeBytes: number }> {
  const head = await deps.storage.headObject?.(key);
  return { key, sizeBytes: head?.sizeBytes ?? 0 };
}

async function writeBytes(
  deps: JobRunDeps,
  key: string,
  contentType: string,
  width: number,
  height: number,
  durationMs = 0,
): Promise<void> {
  await writeBytesIfMissing(deps, key, contentType, width, height, durationMs);
}

/**
 * Writes the deterministic placeholder only when the provider did not already
 * write a real object.
 *
 * The mock providers return a key without bytes; the real providers put the
 * actual file there. Unconditionally overwriting was a bug that replaced a real
 * rendered reel with 100 bytes of JSON.
 */
async function writeBytesIfMissing(
  deps: JobRunDeps,
  key: string,
  contentType: string,
  width: number,
  height: number,
  durationMs = 0,
): Promise<void> {
  if (deps.storage.headObject !== undefined) {
    const existing = await deps.storage.headObject(key);
    if (existing !== null) {
      return;
    }
  }

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
