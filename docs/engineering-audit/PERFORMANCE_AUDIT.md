# Performance & Reliability Audit — RenderFlow

> Read-only assessment plus locally executed verification, 2026-11-20.
> This audit reports what was measured. It does not invent throughput numbers.

## 1. Summary

| Area                               | Status     | Notes                                                                                      |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Credit reserve concurrency         | PASS       | 100 parallel reserves covered in `tests/integration/credit-engine.spec.ts`                 |
| Stage machine / checkpoints        | PASS       | Unit + integration + chaos, including real SIGKILL resume                                  |
| Lease / heartbeat mechanism        | PARTIAL    | Durable lease works; `HeartbeatHandle.lost` is not consumed by generation workers (AUD-09) |
| Content→media handoff              | OPEN (P1)  | Completed-stage routing can leave a multi-stage job unfinished (AUD-23)                    |
| Publisher lease ownership          | OPEN (P1)  | Post-claim writes are not all guarded by `worker_id` (AUD-24)                              |
| Outbox at-least-once delivery      | PARTIAL    | Relay is transactional; deterministic BullMQ IDs need review (AUD-28)                      |
| Queue backpressure / drain         | NOT TESTED | k6 load script exists; no load gate in CI                                                  |
| Shutdown / drain order             | OPEN       | Dependency ordering needs verification (AUD-38)                                            |
| Observability wiring               | PARTIAL    | Metrics/alerts/Grafana provisioned; Redis scrape target and `METRICS_PORT` need fixes      |
| Grafana rendering / alert delivery | BLOCKED    | No Docker daemon and no real webhook receiver                                              |

## 2. What is verified

- **Credit hot path.** Reserve/capture/refund are single guarded transactions.
  The integration suite exercises 100 parallel reserves and C1–C12 invariants;
  all 533 integration tests pass on real Postgres.
- **Rendering.** Real FFmpeg render tests produce real media locally; no mock is
  used for the render itself (`tests/integration/ffmpeg-render.spec.ts`).
- **Failure recovery.** Chaos R1–R5 passes 40/40, including a real SIGKILL inside
  `SCRIPT`, lease expiry, reaper requeue with the original payload, checkpoint
  resume in a second process, and exactly one capture/refund.
- **Idempotent generation settlement.** A settled job is never re-queued; chaos
  asserts zero ledger drift after each scenario.
- **Index coverage.** `tests/integration/schema-indexes.spec.ts` pins the indexes
  the hot queries need.
- **Browser timings (not performance SLOs).** The seeded 14-test Playwright
  journey completes in roughly 24–28 s locally, with the full signup→schedule
  flow around 4–6 s per project. These numbers describe the test harness only.

## 3. Open reliability defects

### AUD-23 — content→media handoff can stall (P1)

`libs/jobs/src/runner.ts` emits `job.stage_completed` with the **completed**
stage. The outbox relay routes directly from that stage using the owner map in
`libs/common/src/queues/queue-names.ts`. After `SCRIPT`, the event routes back to
the content worker, which sees `IMAGE` as the next stage and returns `HANDED_OFF`
without publishing a media-queue message. Capture occurs only after all stages
complete, so credits can remain reserved indefinitely. The integration test at
`tests/integration/job-runner.spec.ts:421-443` currently codifies the completed-
stage routing.

Fix: emit or route the **next** stage and add a relay→queue→worker integration
test instead of calling `runJob()` directly.

### AUD-09 — heartbeat loss is not propagated (P1)

`HeartbeatHandle.lost` is created by the lease machinery but never consumed by
`handleGenerationJob`; provider calls are not signal-aware. A worker that loses
its lease can keep rendering and race the reaper. Fix: propagate an abort signal
into the runner and provider calls, with a regression test that loses the lease
mid-stage.

### AUD-24 — publisher lease ownership after claim (P1)

The initial publish claim is guarded (`libs/social/src/publisher.ts:112-157`),
but release, reclaim, heartbeat, failure update, and `markPublished` filter only
by job ID (`processor.ts:200-215,489-502,521-541`; `publisher.ts:275-286,307-326`).
A stale worker can extend or clear another worker's lease and overwrite terminal
status. Fix: guard every post-claim write with `status='PUBLISHING' AND worker_id=…`.

### AUD-28 / AUD-29 — outbox and refund message semantics

Deterministic BullMQ IDs derived from an insufficiently unique event identity can
collapse distinct outbox events, and `credits.refunded` messages need explicit
terminal no-op/ack semantics. Both need regression tests before production.

### AUD-08 / AUD-40 — Jest open handles

Both unit and integration runs print "did not exit one second after the test run"
and the unit run reports a worker force-exit. This is a test-harness reliability
problem: it hides teardown leaks and makes CI duration unpredictable. Investigate
with `--detectOpenHandles`.

### AUD-35–AUD-38 — operational wiring

- Pre-deploy script bash bug: validate with `bash -n` and fix.
- Prometheus Redis scrape target points at the Redis protocol port, not a Redis
  exporter; add `redis_exporter` or remove the target.
- `METRICS_PORT` is a single variable used by multiple processes; local E2E had
  to assign 4010–4013 manually. Use per-service env vars or unique defaults.
- Shutdown drain order must be verified so consumers stop before their DB/Redis
  dependencies close.

## 4. Not measured

No k6 results, p50/p95/p99 latency, sustained throughput, queue-depth recovery
time, image-build timing, or Docker Compose boot timing were produced here. The
load script exists under `tests/load/`, and CI has a load job, but this audit did
not run it and does not claim those gates pass.

Real S3 and real provider latency are also unmeasured. The local S3 stub used for
E2E exists only to complete the browser journey; it is not a performance
substitute for MinIO or the production object store.

## 5. Recommendations before any production claim

1. Fix AUD-23 and AUD-24, then add relay→queue and lease-race integration tests.
2. Consume heartbeat loss (AUD-09) and prove mid-stage cancellation.
3. Resolve outbox/refund message semantics (AUD-28/AUD-29).
4. Run k6 load and same-minute publish tests; record actual p95 and recovery times.
5. Fix observability wiring (AUD-35–AUD-38) and verify Grafana/alert delivery in
   the compose stack once Docker is available.
