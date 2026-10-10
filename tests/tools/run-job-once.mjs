#!/usr/bin/env node
/**
 * Runs one generation job through the pipeline, in-process.
 *
 * Used by `scripts/smoke-phase4.sh` in place of the two BullMQ workers, because
 * there is no Redis in this environment. It is the *same* runner the workers
 * call, so a passing smoke run says something about the shipped pipeline rather
 * than about a stand-in.
 *
 * It lives under `tests/` rather than `scripts/` for one reason: pnpm only links
 * a workspace package's dependencies into the package that declares them, and
 * the repo root declares none of the `@renderflow/*` packages. Node resolves
 * imports from the file's own directory upwards, so `tests/node_modules` is the
 * only place this can resolve them from.
 *
 * The two invocations mirror the real split: content-worker runs PLAN and SCRIPT,
 * then media-worker runs IMAGE, VOICE and RENDER. Both are idempotent, so running
 * the pair twice is harmless.
 *
 *   JOB_ID=<uuid> [FAIL_STAGE=RENDER] DATABASE_URL=... node scripts/run-job-once.mjs
 */

import { getDb, disconnectDb } from '@renderflow/db';
import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from '@renderflow/ai';
import { stagesForQueue } from '@renderflow/common';
import { failJob, processJob } from '@renderflow/jobs';

const jobId = process.env.JOB_ID;

if (jobId === undefined || jobId === '') {
  console.error('JOB_ID is required');
  process.exit(1);
}

/**
 * Content and media stages, derived from the same routing table the relay uses,
 * so this script cannot drift from the workers' idea of who owns what.
 */
const CONTENT_STAGES = stagesForQueue('content');
const MEDIA_STAGES = stagesForQueue('media');

const db = getDb();

/**
 * Stand-in for S3.
 *
 * In a deployed environment this is a real bucket. Here the bytes only have to
 * be distinguishable from "no output", because the checkpoints - not the
 * objects - are what the resume logic reads. The keys are still real and still
 * land in `job_checkpoints`, which is what the next stage and the API read.
 */
const storage = {
  async putObject({ key, body, contentType }) {
    return { key, contentType, sizeBytes: body.byteLength, metadata: {} };
  },
};

try {
  // FAIL_STAGE / FAIL_RATE / FAIL_EVERY_NTH are read here, not parsed above:
  // one function owns the meaning of the mock's environment, so a second
  // reader in this script could only drift from it.
  const options = mockOptionsFromEnv(process.env);
  const providers = {
    text: new MockTextProvider(options),
    image: new MockImageProvider(options),
    tts: new MockTtsProvider(options),
    renderer: new MockRendererProvider(options),
  };

  for (const stages of [CONTENT_STAGES, MEDIA_STAGES]) {
    const result = await processJob(
      { db, storage, providers, stages: [...stages], defaultAttempts: 1 },
      jobId,
    );

    console.log(
      JSON.stringify({
        stage: stages.join('+'),
        outcome: result.outcome,
        stagesRun: result.stagesRun,
      }),
    );

    // The media pass is where a forced failure lands; once the job has settled
    // there is nothing left for the next pass to do.
    if (result.outcome === 'FAILED') {
      break;
    }
  }
} catch (error) {
  // The worker rethrows so BullMQ can retry; here there is no queue, so the
  // refund has to happen before the process exits or the reservation is stranded.
  console.error('pipeline error:', error instanceof Error ? error.message : error);
  await failJob(db, jobId, error instanceof Error ? error.message : 'unknown error');
  await disconnectDb();
  process.exit(1);
}

await disconnectDb();
