/**
 * The database-level half of the chaos suite (PROJECT.md section 13.4, R1-R4).
 *
 * Run by `tests/chaos/run.sh`, which owns the reporting; this file only produces
 * assertions. It is the same library code the integration suite drives, invoked
 * from a script an operator can point at a real deployment when something has
 * gone wrong - which is the case the gate is not for.
 *
 * What is simulated, and how honestly
 * ------------------------------------
 * A worker's death is reproduced as the exact database state SIGKILL leaves:
 * PROCESSING, a lease nobody will renew, and whatever checkpoints were written
 * before the lights went out. Every recovery decision - reclaim, resume from
 * checkpoint, refund exactly once - is the real one, taken by the real reaper and
 * the real runner.
 *
 * What is NOT simulated: the process itself. The SIGKILL scenario (R5) lives in
 * the shell script, needs a real Redis, and is reported as SKIPPED rather than
 * passed when Redis is absent.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getDb, disconnectDb } from '@renderflow/db';
import { adjust, reserve, getBalance } from '@renderflow/credits';
import {
  acquireLease,
  processJob,
  releaseLease,
  sweepOnce,
  workerIdForProcess,
} from '@renderflow/jobs';
import {
  MockImageProvider,
  MockRendererProvider,
  MockTextProvider,
  MockTtsProvider,
} from '@renderflow/ai';

const db = getDb();
const WORKSPACE = randomUUID();
const CONTENT = ['PLAN', 'SCRIPT'];
const MEDIA = ['IMAGE', 'VOICE', 'RENDER'];
const LEASE = { leaseSeconds: 120, heartbeatSeconds: 30, maxAttempts: 3 };

const results = [];
const check = (label, expected, actual) =>
  results.push({ label, expected: String(expected), actual: String(actual) });

const storage = {
  async putObject({ key, body, contentType }) {
    return { key, contentType, sizeBytes: body.byteLength, metadata: {} };
  },
};

function providers(extra = {}) {
  const shared = { sequence: { count: 0 }, ...extra };
  return {
    text: new MockTextProvider(shared),
    image: new MockImageProvider(shared),
    tts: new MockTtsProvider(shared),
    renderer: new MockRendererProvider(shared),
  };
}

const user = { id: randomUUID() };
await db.execute(sql`
  INSERT INTO users (id, email, password_hash, name)
  VALUES (${user.id}, ${`chaos-${user.id}@example.com`}, 'x', 'Chaos')`);

// The bonus goes in the way the app writes it: an append-only ledger row and a
// wallet, in one transaction. A harness that hand-inserted a balance would be
// testing a state the product never creates.
await db.transaction(async (tx) => {
  const bonus = Number(process.env.SIGNUP_BONUS_CREDITS ?? 50);
  await tx.execute(sql`INSERT INTO wallets (user_id, available, reserved)
                       VALUES (${user.id}, ${bonus}, 0)`);
  await tx.execute(sql`
    INSERT INTO credit_ledger (user_id, entry_type, amount, reference_type, reference_id, note)
    VALUES (${user.id}, 'SIGNUP_BONUS', ${bonus}, 'USER', ${user.id}, 'chaos signup bonus')`);
});

const newJob = () =>
  db.transaction((tx) =>
    reserve(tx, { userId: user.id, kind: 'REEL', workspaceId: WORKSPACE, maxAttempts: 3 }),
  );

const wallet = () => getBalance(db, user.id);

/**
 * Tops the wallet up between scenarios.
 *
 * Through `adjust`, not a direct UPDATE: an adjustment writes a ledger row, so
 * the R4 reconciliation check at the end is still meaningful. A harness that
 * injected credits behind the ledger would prove nothing about drift - it would
 * be manufacturing the very inconsistency it then claims to rule out.
 */
const topUp = (amount) =>
  db.transaction((tx) =>
    adjust(tx, { userId: user.id, amount, reason: 'chaos: fund the next scenario' }),
  );

const checkpointsOf = async (jobId) => {
  const rows = await db.execute(sql`
    SELECT stage::text AS stage FROM job_checkpoints
     WHERE job_id = ${jobId}::uuid ORDER BY created_at`);
  return rows.rows.map((r) => r.stage).join(',');
};

/** Exactly the state `kill -9` leaves: PROCESSING, a lease nobody renews. */
const simulateKill = (jobId, attempts) =>
  db.execute(sql`
    UPDATE generation_jobs
       SET status = 'PROCESSING',
           worker_id = ${`dead-worker-${attempts}`},
           heartbeat_at = now() - make_interval(secs => 600),
           locked_until = now() - make_interval(secs => 60),
           attempts = ${attempts}
     WHERE id = ${jobId}::uuid`);

// --- R1: killed at IMAGE, another worker resumes from checkpoint ------------
const first = await newJob();
await processJob(
  {
    db,
    storage,
    providers: providers(),
    stages: CONTENT,
    lease: { workerId: workerIdForProcess('a'), config: LEASE },
  },
  first.jobId,
);
check(
  'R1 content stages completed before the kill',
  'PLAN,SCRIPT',
  await checkpointsOf(first.jobId),
);

await simulateKill(first.jobId, 1);
const swept = await sweepOnce(db);
check('R1 reaper re-queues the job', first.jobId, swept.requeued.join(','));

// Claimability is checked by acquiring and RELEASING. Holding the lease across
// into processJob is what a worker actually does - and it correctly refuses a
// second claim while it is held, which is the whole point of the guard.
const reclaimer = workerIdForProcess('b');
const claimed = await acquireLease(db, first.jobId, reclaimer, LEASE);
check('R1 a second worker can take the lease', 'true', String(claimed !== null));
await releaseLease(db, first.jobId, reclaimer);

const resumed = await processJob(
  {
    db,
    storage,
    providers: providers(),
    stages: MEDIA,
    lease: { workerId: reclaimer, config: LEASE },
  },
  first.jobId,
);
check('R1 resumes and completes', 'COMPLETED', resumed.outcome);
check('R1 did not redo PLAN or SCRIPT', 'IMAGE,VOICE,RENDER', resumed.stagesRun.join(','));
check(
  'R1 all five stages present once',
  'PLAN,SCRIPT,IMAGE,VOICE,RENDER',
  await checkpointsOf(first.jobId),
);

const afterCapture = await wallet();
check('R1 charged once, at the end', '20,0', `${afterCapture.available},${afterCapture.reserved}`);

const captures = await db.execute(sql`
  SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id = ${user.id}::uuid AND entry_type = 'CAPTURE'`);
check('R1 exactly one CAPTURE row', '1', captures.rows[0].n);

// --- R2: retries run out mid-render, refunded exactly once -----------------
// R1 spent 30 of the welcome bonus. Top up before spending it again, or R2 is
// really testing "cannot afford", which is not what it claims to be.
await topUp(30);

const doomed = await newJob();
await processJob(
  {
    db,
    storage,
    providers: providers(),
    stages: CONTENT,
    lease: { workerId: workerIdForProcess('c'), config: LEASE },
  },
  doomed.jobId,
);

for (let attempt = 1; attempt <= 3; attempt += 1) {
  await simulateKill(doomed.jobId, attempt);
  await sweepOnce(db);
}

const afterRefund = await wallet();
check('R2 credits returned in full', '50,0', `${afterRefund.available},${afterRefund.reserved}`);

const refunds = await db.execute(sql`
  SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id = ${user.id}::uuid AND entry_type = 'REFUND'`);
check('R2 exactly one REFUND row', '1', refunds.rows[0].n);

const failedAgain = await sweepOnce(db);
check('R2 a settled job is never re-queued', '0', failedAgain.requeued.length);

// --- R3: a slow worker keeps its lease --------------------------------------
await topUp(30);

const slow = await newJob();
await acquireLease(db, slow.jobId, workerIdForProcess('slow'), LEASE);
const slowSweep = await sweepOnce(db);
check('R3 a live lease is never stolen', '', slowSweep.requeued.join(','));
check(
  'R3 the job is still owned',
  'PROCESSING',
  (
    await db.execute(sql`
  SELECT status::text AS status FROM generation_jobs WHERE id = ${slow.jobId}::uuid`)
  ).rows[0].status,
);

// --- R4: the ledger still reconciles after all of that ----------------------
const { reconcileAll } = await import('@renderflow/credits');
const reports = await reconcileAll(db);
const drifted = reports.filter((r) => r.drifted);
check('R4 zero drift after every scenario', '0', drifted.length);

process.stdout.write(JSON.stringify(results));
await disconnectDb();
