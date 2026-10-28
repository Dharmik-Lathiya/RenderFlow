#!/usr/bin/env node
/**
 * Chaos scenario R5: a real SIGKILL, then the real recovery path.
 *
 * The other four scenarios in `recovery-harness.mjs` reproduce the database
 * state a killed worker leaves behind. This one kills an actual process, so the
 * things they cannot prove are exercised for real:
 *
 *   1. the heartbeat is running and stops because the process is gone;
 *   2. the lease expires on its own, with no graceful release;
 *   3. the real reaper requeues the job with a complete `job.created` payload;
 *   4. a second process resumes from the checkpoint the first one wrote;
 *   5. the user is captured once and never refunded.
 *
 * It does not need Redis. The queue message is read from `outbox_events`, which
 * is exactly what the relay would publish, and the second worker consumes that
 * event directly. Avoiding Redis here is deliberate: the scenario's hard part is
 * process death and lease expiry, not a broker, and a test that only runs when a
 * daemon happens to be up is a test that quietly stops covering anything.
 *
 * Run by `tests/chaos/run.sh`, which owns PASS/FAIL reporting.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { getDb, disconnectDb } from '@renderflow/db';
import { jobCreatedEventSchema } from '@renderflow/common';
import { getBalance, reconcileAll, reserve } from '@renderflow/credits';
import { sweepOnce } from '@renderflow/jobs';

const db = getDb();
const workerPath = fileURLToPath(new URL('./r5-worker.mjs', import.meta.url));
const results = [];
const check = (label, expected, actual) =>
  results.push({ label, expected: String(expected), actual: String(actual) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnWorker(env) {
  const child = spawn(process.execPath, [workerPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, exited, output: () => ({ stdout, stderr }) };
}

const jobRow = async (jobId) => {
  const rows = await db.execute(sql`
    SELECT status::text AS status,
           attempts,
           worker_id,
           captured,
           refunded,
           locked_until > now() AS lease_valid
      FROM generation_jobs
     WHERE id = ${jobId}::uuid`);
  return rows.rows[0];
};

const checkpointsOf = async (jobId) => {
  const rows = await db.execute(sql`
    SELECT stage::text AS stage
      FROM job_checkpoints
     WHERE job_id = ${jobId}::uuid
     ORDER BY created_at`);
  return rows.rows.map((row) => row.stage).join(',');
};

let runDir;

try {
  // --- a user and a job created exactly the way the product creates them ----
  const user = { id: randomUUID() };
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES (${user.id}, ${`r5-${user.id}@example.com`}, 'x', 'R5')`);

  await db.transaction(async (tx) => {
    const bonus = Number(process.env.SIGNUP_BONUS_CREDITS ?? 50);
    await tx.execute(sql`INSERT INTO wallets (user_id, available, reserved)
                         VALUES (${user.id}, ${bonus}, 0)`);
    await tx.execute(sql`
      INSERT INTO credit_ledger (user_id, entry_type, amount, reference_type, reference_id, note)
      VALUES (${user.id}, 'SIGNUP_BONUS', ${bonus}, 'USER', ${user.id}, 'chaos signup bonus')`);
  });

  const workspaceId = randomUUID();
  const job = await db.transaction((tx) =>
    reserve(tx, { userId: user.id, kind: 'REEL', workspaceId, maxAttempts: 3 }),
  );

  runDir = mkdtempSync(join(tmpdir(), 'renderflow-r5-'));
  const markerFile = join(runDir, 'script.marker');

  // --- the first worker: content stages, killed inside SCRIPT --------------
  const first = spawnWorker({
    JOB_ID: job.jobId,
    R5_QUEUE: 'content',
    R5_WORKER_ID: 'r5-first',
    R5_LEASE_SECONDS: '6',
    R5_HEARTBEAT_SECONDS: '1',
    R5_MARKER_FILE: markerFile,
    // Long enough that the marker is observed while the child is still inside
    // the caption call, not merely before it starts.
    MOCK_LATENCY_MS: '2000',
  });

  await waitFor(() => existsSync(markerFile), 30_000, 'first worker reaching SCRIPT');
  check('R5 worker reached SCRIPT', 'true', 'true');

  first.child.kill('SIGKILL');
  const firstExit = await withTimeout(first.exited, 10_000, 'first worker exit');
  check('R5 first worker died by SIGKILL', 'SIGKILL', firstExit.signal ?? `code ${firstExit.code}`);

  const killed = await jobRow(job.jobId);
  check('R5 the kill left the job PROCESSING', 'PROCESSING', killed.status);
  check('R5 the attempt was counted on the durable row', '1', killed.attempts);
  check('R5 the dead worker still owns the lease', 'r5-first', killed.worker_id);
  check('R5 PLAN was checkpointed before the kill', 'PLAN', await checkpointsOf(job.jobId));
  check(
    'R5 the killed worker never checkpointed SCRIPT',
    'false',
    String((await checkpointsOf(job.jobId)).includes('SCRIPT')),
  );
  check(
    'R5 the lease is still valid immediately after the kill',
    'true',
    String(killed.lease_valid === true),
  );

  // A live lease must not be stolen. This is the difference between "the worker
  // is dead" and "the worker is slow", and getting it wrong is how two workers
  // render the same reel.
  const early = await sweepOnce(db);
  check('R5 a valid lease is not stolen', 'false', String(early.requeued.includes(job.jobId)));

  // --- the lease expires, and the real reaper makes its decision -----------
  await waitFor(
    async () => {
      const current = await jobRow(job.jobId);
      return current.lease_valid === false;
    },
    20_000,
    'lease expiry',
    100,
  );
  check('R5 the lease expires on its own', 'true', 'true');

  const swept = await sweepOnce(db);
  check(
    'R5 the reaper requeues the killed job',
    'true',
    String(swept.requeued.includes(job.jobId)),
  );

  const events = await db.execute(sql`
    SELECT dedupe_key, payload
      FROM outbox_events
     WHERE aggregate_id = ${job.jobId}
       AND event_type = 'job.created'
     ORDER BY created_at`);
  check('R5 the original event and one requeue exist', '2', events.rows.length);

  const requeue = events.rows.find((row) => row.dedupe_key.includes(':job.requeued:'));
  let requeuedPayload;
  try {
    requeuedPayload = jobCreatedEventSchema.parse(requeue?.payload);
  } catch {
    requeuedPayload = undefined;
  }
  check(
    'R5 the requeue carries a complete job.created payload',
    'true',
    String(requeuedPayload !== undefined),
  );

  if (requeuedPayload === undefined) {
    throw new Error('the reaper requeue payload is not a valid job.created event');
  }

  check('R5 the requeue names the original workspace', workspaceId, requeuedPayload.workspaceId);
  check('R5 the requeue keeps the original reservation', '30', requeuedPayload.creditsReserved);

  // --- the second worker resumes and finishes ------------------------------
  const second = spawnWorker({
    JOB_ID: job.jobId,
    R5_QUEUE: 'all',
    R5_WORKER_ID: 'r5-resumed',
    R5_LEASE_SECONDS: '30',
    R5_HEARTBEAT_SECONDS: '2',
    MOCK_LATENCY_MS: '0',
  });

  const secondExit = await withTimeout(second.exited, 60_000, 'resumed worker exit');
  check('R5 the resumed worker exits cleanly', '0', secondExit.code);
  if (secondExit.code !== 0) {
    throw new Error(`the resumed worker failed:\n${second.output().stderr}`);
  }

  const done = await jobRow(job.jobId);
  check('R5 the job completes', 'COMPLETED', done.status);
  check('R5 the job is captured once', '1', done.captured);
  check('R5 the job is never refunded', '0', done.refunded);
  check('R5 the attempt counter survived the requeue', '2', done.attempts);
  check(
    'R5 every stage has exactly one checkpoint',
    'PLAN,SCRIPT,IMAGE,VOICE,RENDER',
    await checkpointsOf(job.jobId),
  );

  const balance = await getBalance(db, user.id);
  check(
    'R5 the user is charged once, at the end',
    '20,0',
    `${balance.available},${balance.reserved}`,
  );

  const ledger = await db.execute(sql`
    SELECT entry_type::text AS entry_type, COUNT(*)::int AS n
      FROM credit_ledger
     WHERE user_id = ${user.id}::uuid
     GROUP BY entry_type`);
  const byType = Object.fromEntries(ledger.rows.map((row) => [row.entry_type, row.n]));
  check('R5 one RESERVE row', '1', byType.RESERVE ?? 0);
  check('R5 one CAPTURE row', '1', byType.CAPTURE ?? 0);
  check('R5 zero REFUND rows', '0', byType.REFUND ?? 0);

  const drifted = (await reconcileAll(db)).filter((report) => report.drifted);
  check('R5 zero ledger drift afterwards', '0', drifted.length);

  process.stdout.write(JSON.stringify(results));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (runDir !== undefined) {
    rmSync(runDir, { recursive: true, force: true });
  }
  await disconnectDb();
}
