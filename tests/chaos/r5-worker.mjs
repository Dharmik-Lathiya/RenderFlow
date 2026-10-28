#!/usr/bin/env node
/**
 * One real worker process for chaos scenario R5.
 *
 * This is deliberately a separate process, spawned by `r5-harness.mjs` and
 * killed with SIGKILL while it is inside SCRIPT. It uses the same
 * `handleGenerationJob` the production workers use, including the heartbeat, so
 * the state it leaves behind after the kill is the state a real worker leaves:
 *
 *   - PROCESSING with a lease that will never be renewed;
 *   - the stages it finished checkpointed in Postgres;
 *   - the stage it was in the middle of NOT checkpointed.
 *
 * It reads the queue payload from `outbox_events` instead of inventing one,
 * because the message a worker receives is exactly what the relay would publish.
 * After the reaper requeues the job, this reads the requeue event (the newest
 * `job.created` row), which is what proves the reaper's payload is complete.
 *
 * Environment:
 *   JOB_ID             required
 *   DATABASE_URL       required
 *   R5_QUEUE           content | media | all (default all)
 *   R5_WORKER_ID       lease owner (default r5-worker-<pid>)
 *   R5_LEASE_SECONDS   default 6
 *   R5_HEARTBEAT_SECONDS default 1
 *   R5_MARKER_FILE     optional; written when SCRIPT starts, so the parent can
 *                      kill this process while it is actually in that stage
 *   MOCK_LATENCY_MS    provider latency; the marker is only useful with a delay
 */

import { writeFileSync } from 'node:fs';

import { getDb, disconnectDb } from '@renderflow/db';
import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
  mockOptionsFromEnv,
} from '@renderflow/ai';
import { stagesForQueue } from '@renderflow/common';
import { handleGenerationJob, workerIdForProcess } from '@renderflow/jobs';
import { sql } from 'drizzle-orm';

const jobId = process.env.JOB_ID;
if (jobId === undefined || jobId === '') {
  process.stderr.write('JOB_ID is required\n');
  process.exit(1);
}

const queue = process.env.R5_QUEUE ?? 'all';
const stages =
  queue === 'all' ? undefined : [...stagesForQueue(queue === 'media' ? 'media' : 'content')];

const leaseSeconds = Number(process.env.R5_LEASE_SECONDS ?? 6);
const heartbeatSeconds = Number(process.env.R5_HEARTBEAT_SECONDS ?? 1);
const workerId = process.env.R5_WORKER_ID ?? workerIdForProcess('r5');
const markerFile = process.env.R5_MARKER_FILE;

const db = getDb();

/**
 * Stand-in for S3, as in the other local harnesses. The checkpoint rows are what
 * the resume logic reads; the bytes only have to exist conceptually.
 */
const storage = {
  async putObject({ key, body, contentType }) {
    return { key, contentType, sizeBytes: body.byteLength, metadata: {} };
  },
};

async function readNewestJobCreatedEvent() {
  const rows = await db.execute(sql`
    SELECT payload
      FROM outbox_events
     WHERE aggregate_id = ${jobId}
       AND event_type = 'job.created'
     ORDER BY created_at DESC
     LIMIT 1`);
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error(`no job.created event for job ${jobId}`);
  }
  return row.payload;
}

const options = mockOptionsFromEnv(process.env);
const baseText = new MockTextProvider(options);

/**
 * The marker is written before the caption call, so the parent knows the
 * process is inside SCRIPT rather than merely scheduled to run it. With a
 * non-zero MOCK_LATENCY_MS the child is still there when SIGKILL arrives.
 */
const text =
  markerFile === undefined
    ? baseText
    : {
        plan: (input) => baseText.plan(input),
        caption: (input) => {
          writeFileSync(
            markerFile,
            JSON.stringify({ stage: 'SCRIPT', pid: process.pid, at: Date.now() }),
          );
          return baseText.caption(input);
        },
        script: (input) => baseText.script(input),
      };

try {
  const data = await readNewestJobCreatedEvent();

  await handleGenerationJob(
    {
      db,
      storage,
      providers: {
        text,
        image: new MockImageProvider(options),
        tts: new MockTtsProvider(options),
        renderer: new MockRendererProvider(options),
      },
      ...(stages === undefined ? {} : { stages }),
      lease: { workerId, config: { leaseSeconds, heartbeatSeconds, maxAttempts: 3 } },
      defaultAttempts: 3,
    },
    { data, attemptsMade: 0, attempts: 3 },
  );

  process.stdout.write(`${JSON.stringify({ workerId, jobId, queue })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await disconnectDb();
}
