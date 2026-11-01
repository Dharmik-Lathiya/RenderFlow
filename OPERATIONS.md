# Operations

This is the on-call and day-to-day operations guide for RenderFlow. It assumes
the deployment topology in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

**Verified against:** repository at 2026-11-01. Commands that require a running
stack were exercised locally where the environment allowed; Docker-dependent
checks are marked as unverified.

## 1. Service map

| Service            | Depends on                              | Failure a user sees                                            |
| ------------------ | --------------------------------------- | -------------------------------------------------------------- |
| `api`              | PostgreSQL, Redis, S3                   | Login, dashboard, generation and scheduling fail.              |
| `web`              | API (browser and server-side)           | Pages fail to load or show stale/error states.                 |
| `outbox-relay`     | PostgreSQL, Redis                       | Jobs stay `PENDING`; schedules never reach the queue.          |
| `content-worker`   | PostgreSQL, Redis, S3, text AI          | Generation stops at PLAN/SCRIPT; jobs become stuck.            |
| `media-worker`     | PostgreSQL, Redis, S3, media AI, FFmpeg | Generation stops at IMAGE/VOICE/RENDER; jobs become stuck.     |
| `publisher-worker` | PostgreSQL, Redis, social APIs          | Scheduled posts miss their time; publish failures appear.      |
| `analytics-worker` | PostgreSQL, Redis, social APIs          | Metrics stop refreshing; publishing still works.               |
| `reaper`           | PostgreSQL, Redis                       | Crashed workers are not recovered; leases stay expired.        |
| PostgreSQL         | —                                       | Everything fails; this is the source of truth.                 |
| Redis              | —                                       | Queue delivery stops; database-backed polls partially recover. |
| S3                 | —                                       | Uploads, generated media and download URLs fail.               |

## 2. First five minutes of an incident

1. Confirm the scope: one workspace, one route, one worker, or everything?
2. Check the API process:
   ```bash
   curl -fsS https://api.example.com/health/live
   curl -fsS https://api.example.com/metrics | grep -E 'renderflow_(stuck_jobs|ledger_drift_users|outbox_abandoned_events|queue_depth|collector_ok)'
   ```
3. Check that every worker process is running and not crash-looping.
4. Check PostgreSQL and Redis connectivity from the API/worker network.
5. Check the outbox backlog and the oldest unprocessed event.
6. Check `publish_jobs` for due rows that no publisher has claimed.
7. If credits are involved, run reconciliation before changing anything.
8. Preserve logs and row ids before restarting a process that may be holding
   evidence.

`/health/ready` is not a dependency check yet. It returns `ok` with an empty
`checks` object because no probes are registered. Do not use it to conclude that
PostgreSQL, Redis or S3 are healthy.

## 3. Monitoring

### Metrics that work

The API exposes Prometheus metrics at `/metrics`. The important ones:

| Metric                                       | Meaning                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `renderflow_jobs_by_status{status}`          | Jobs created in the last hour, by status.                              |
| `renderflow_jobs_in_window`                  | Jobs created in the last hour.                                         |
| `renderflow_job_failure_rate`                | Failure rate in the last hour.                                         |
| `renderflow_job_duration_p95_seconds{stage}` | p95 stage duration.                                                    |
| `renderflow_stuck_jobs`                      | Unfinished past every legitimate duration, or finished but uncaptured. |
| `renderflow_queue_depth{queue}`              | Waiting + delayed BullMQ jobs, sourced by the API.                     |
| `renderflow_outbox_pending_events`           | Unprocessed outbox rows.                                               |
| `renderflow_outbox_abandoned_events`         | Events past the relay attempt budget.                                  |
| `renderflow_credits_refunded_window`         | Credits refunded in the last hour.                                     |
| `renderflow_ledger_drift_users`              | Users whose wallet disagrees with the ledger.                          |
| `renderflow_publish_failures_window`         | Permanent publish failures in the last hour.                           |
| `renderflow_collector_ok{section}`           | 1 if a collector section succeeded; 0 means its gauges are stale.      |

### Monitoring caveats

These are known gaps, not hypotheticals:

- **Worker metrics exist, but they are process metrics.** Each worker serves
  `/metrics` on its own port (`METRICS_PORT`, defaulting to 4001–4006 in Compose).
  They report event-loop lag, heap, GC and the registered Prometheus registry;
  they do not run the database collector. The API remains the only source of the
  row-derived gauges.
- **The Redis scrape target is not an exporter.** `redis:6379` does not serve
  `/metrics`. Use a Redis exporter or remove the target.
- **Alertmanager is deployed in the observability profile.** Prometheus sends
  firing alerts to `alertmanager:9093`; Alertmanager routes them to Slack when
  `SLACK_WEBHOOK_URL` is set. Without a webhook it still starts and exposes
  firing alerts on `:9093`, but nothing leaves the host.
- **Grafana has provisioned dashboards and datasources**, but the panels have
  never been rendered in this environment because Docker is unavailable. Validate
  the dashboard before relying on it.
- **`renderflow_queue_depth` is sampled by the API**, not by workers. If the API
  is down, queue depth is stale.

Until these are fixed, alert on the API's database-derived gauges and on
process-level liveness, and monitor worker existence through the orchestrator.

## 4. Alert runbook index

Rules live in [`infra/prometheus/alerts.yml`](./infra/prometheus/alerts.yml).
Every rule has a `for:` clause.

| Alert                         | Severity | First checks                                                             |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `RenderFlowStuckJobs`         | warning  | `GET /admin/dlq`; worker processes; `renderflow_collector_ok`.           |
| `RenderFlowStuckJobsCritical` | critical | Worker outage or dependency outage; queue backlog; provider latency.     |
| `RenderFlowPublishFailures`   | warning  | Social token expiry; adapter errors; `publish_jobs.error`.               |
| `RenderFlowOutboxAbandoned`   | warning  | Relay running; Redis reachable; replay events after fixing the cause.    |
| `RenderFlowLedgerDrift`       | critical | `GET /admin/reconcile`; do not adjust until the cause is understood.     |
| `RenderFlowHighFailureRate`   | warning  | Provider outage, misconfigured mocks, bad deploy.                        |
| `RenderFlowNoJobsAtAll`       | warning  | Queue has work but no consumer; worker crash loop.                       |
| `RenderFlowQueueBacklog`      | warning  | Scale workers or find the slow stage/provider.                           |
| `RenderFlowCollectorBroken`   | warning  | API cannot derive a metric section; check logs for the section name.     |
| `RenderFlowRefundSpike`       | warning  | Provider failures or a logic bug refunding work that should be captured. |
| `RenderFlowTargetDown`        | critical | Expect false positives for worker/Redis targets until those are fixed.   |

## 5. Runbooks

### 5.1 Stuck generation jobs

Symptoms: `renderflow_stuck_jobs > 0`, jobs remain `PROCESSING` past the lease,
or jobs are `COMPLETED` without `captured = 1`.

1. Confirm the reaper is running. Without it, expired leases are never reclaimed.
2. Inspect failed jobs:
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.example.com/api/v1/admin/dlq
   ```
3. Check `generation_jobs` for the job: `status`, `stage`, `attempts`,
   `max_attempts`, `locked_until`, `refunded`, `captured`.
4. Check `job_checkpoints` for the completed stages.
5. Check the worker logs by `jobId` and `stage`.
6. If a worker is down, restart it. The reaper will reclaim expired leases.
7. If the job is `FAILED` and refunded, it is in the DLQ. Replay only when the
   underlying provider problem is fixed. A replay re-reserves credits at the
   current price and creates a new job; it fails with `INSUFFICIENT_CREDITS` if
   the user cannot pay.
8. If a job is `COMPLETED` but not captured, do not refund it manually. It is
   counted by `renderflow_stuck_jobs`, but the reaper does not settle completed
   rows and there is no admin capture endpoint. Escalate with the job id, inspect
   the capture transaction, and do not hand-edit wallet rows.

### 5.2 Queue backlog

Symptoms: `renderflow_queue_depth{queue="content|media"} > 100` for 15 minutes,
or jobs wait while workers are healthy.

1. Confirm workers are running and connected to the same Redis database and
   `QUEUE_PREFIX`.
2. Check whether a provider is slow or timing out. Media concurrency is 2 by
   default; rendering is CPU-bound.
3. Check for a poison job that repeatedly fails and occupies a slot.
4. Scale worker replicas. Content and media workers are safe to scale; leases and
   checkpoints prevent duplicate work.
5. Do not delete queue entries to "clear" a backlog. BullMQ state is not the
   source of truth, but deleting entries hides the work rather than completing it.

### 5.3 Publish failures

Symptoms: `renderflow_publish_failures_window > 0`, users report a missed post,
or `publish_jobs.status = FAILED`.

1. Inspect `publish_jobs` for the post and account: `status`, `attempts`,
   `error`, `external_post_id`.
2. If `external_post_id` is set, the post reached the platform. **Do not retry.**
   Reconcile the row and notify the user.
3. If the error is an expired/revoked social token, the user must reconnect the
   account. Do not edit the encrypted token by hand.
4. A transient failure leaves the row `PENDING` for automatic retry. Once a row
   is `FAILED` there is no publish-replay endpoint, and the reschedule endpoint
   only updates `PENDING` or `SCHEDULED` rows. Recreate the schedule after the
   platform recovers, but only when `external_post_id` is empty.
5. Check `social_accounts.token_expires_at` and the adapter logs.
6. Publishing is free; a failed publish does not refund generation credits.

### 5.4 Abandoned outbox events

Symptoms: `renderflow_outbox_abandoned_events > 0` or the reaper logs abandoned
events.

1. Confirm `outbox-relay` is running and can reach both PostgreSQL and Redis.
2. Check the relay logs for the publish error.
3. Inspect abandoned events:
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.example.com/api/v1/admin/dlq/outbox
   ```
4. Fix the cause (Redis credentials, network, queue prefix, payload validation).
5. Replay each event:
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.example.com/api/v1/admin/dlq/outbox/$EVENT_ID/replay
   ```
6. Confirm `renderflow_outbox_pending_events` drains and stops growing.

Replay is idempotent. The relay's deterministic job id prevents a second enqueue
for the same aggregate.

### 5.5 Ledger drift

Symptoms: `renderflow_ledger_drift_users > 0`, or a report of an incorrect
balance.

1. Run reconciliation:
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.example.com/api/v1/admin/reconcile
   ```
2. Compare `available` and `reserved` against the per-bucket ledger sums.
3. Identify the last ledger row and the reference that produced it. Check whether
   a reserve, capture or refund was missed.
4. Do not hand-edit `wallets` or `credit_ledger`. Every mutation must go through
   `libs/credits` and produce an append-only ledger row.
5. If a correction is justified, use the audited adjustment endpoint with a
   reason and a unique `referenceId`:
   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"userId":"...","amount":10,"reason":"...","referenceId":"incident-123"}' \
     https://api.example.com/api/v1/admin/credits/adjust
   ```
6. Re-run reconciliation and confirm the drift is gone.

An adjustment changes the wallet and writes an `ADJUSTMENT` ledger row. It does
not repair the underlying bug. File a follow-up.

### 5.6 Redis is unavailable

1. Expect delayed `post.scheduled` wake-ups and generation hand-offs to stop.
2. Do not delete the outbox. Events remain in PostgreSQL.
3. Restore Redis. The relay republishes unprocessed events.
4. Publisher-worker polls `publish_jobs` every second, so due posts can still go
   out without the wake-up message.
5. Check `renderflow_outbox_pending_events` and `renderflow_queue_depth` after
   recovery.
6. Run a generation and a scheduled publish smoke test.

### 5.7 PostgreSQL is unavailable

1. Stop API and worker restarts if they are crash-looping; a restart storm makes
   failover harder.
2. Fail over to the managed replica or restore from backup.
3. Confirm migrations are at the expected version.
4. Start the API, then the relay and workers.
5. Expect the outbox to drain a backlog.
6. Run reconciliation and a generation smoke test.
7. Check for jobs whose leases expired during the outage; the reaper will reclaim
   them.

### 5.8 S3 is unavailable

1. Uploads fail at the presigned PUT or confirmation step.
2. Generation fails at the first stage that writes an artefact.
3. Retry transient errors; do not mark jobs successful without their artefacts.
4. Check bucket credentials, endpoint, region and path-style configuration.
5. After recovery, replay failed jobs from the DLQ only after confirming the
   provider failure is not permanent.

### 5.9 A worker is crash-looping

1. Read the last logs before the restart. Common causes: missing
   `TOKEN_ENCRYPTION_KEY`, invalid `DATABASE_URL`, unreachable Redis, missing
   provider key, invalid lease configuration.
2. The publisher worker validates `TOKEN_ENCRYPTION_KEY` at boot because it
   cannot publish without decrypting tokens.
3. Fix the environment and restart. Do not run a worker with a made-up key; it
   will fail to decrypt existing tokens.
4. Confirm the queue depth starts falling and stuck jobs are reclaimed.

### 5.10 API is returning 5xx

1. Check `/health/live` and the API logs by `requestId`.
2. Check PostgreSQL and Redis connectivity.
3. Check whether the failure is isolated to generation: a missing
   `pricing_rules` row or provider outage.
4. Check `/metrics` for `renderflow_collector_ok{section="..."} == 0`; a broken
   collector does not break requests, but it explains stale dashboards.
5. Roll back the API image if the errors started with a deploy.

### 5.11 Notifications are missing

- Publish failures write in-app notifications directly from the publisher worker.
- The `notifications` queue has no consumer. Do not assume a notification will be
  delivered because an outbox event was routed to that queue.
- Check `notifications` rows for the user and the dedupe key.
- Email is not implemented. `EMAIL_PROVIDER=none` sends nothing.

## 6. Operator API

All admin routes require a global `ADMIN` or a workspace `OWNER` scoped to the
affected workspace. Use a short-lived session or a bearer token from an
authenticated admin. Do not put admin tokens in shell history on a shared host.

| Route                                 | Method | Purpose                                               |
| ------------------------------------- | ------ | ----------------------------------------------------- |
| `/api/v1/admin/dlq`                   | GET    | Failed generation jobs, refunded and awaiting replay. |
| `/api/v1/admin/dlq/:jobId/replay`     | POST   | Re-reserve and requeue a failed job.                  |
| `/api/v1/admin/dlq/outbox`            | GET    | Abandoned outbox events.                              |
| `/api/v1/admin/dlq/outbox/:id/replay` | POST   | Put an abandoned event back in the pending set.       |
| `/api/v1/admin/reconcile`             | GET    | Per-bucket wallet/ledger comparison.                  |
| `/api/v1/admin/credits/adjust`        | POST   | Audited credit grant or removal.                      |

Every operator mutation writes an `audit_logs` row with the actor and action.
`limit` query parameters are bounded; do not script unbounded polling.

## 7. Routine maintenance

### Daily

- Check `renderflow_stuck_jobs`, `renderflow_ledger_drift_users` and
  `renderflow_outbox_abandoned_events`.
- Check the failed-job DLQ and publish failures.
- Confirm all workers are running.
- Check disk growth for PostgreSQL, Redis and S3.

### Weekly

- Review refunds and manual adjustments for anomalies.
- Review the oldest unprocessed outbox event.
- Check certificate expiry and secret rotation schedule.
- Review dependency advisories.

### Monthly / quarterly

- Run the backup/restore drill: [`docs/backup-restore.md`](./docs/backup-restore.md).
- Test a worker kill and confirm the reaper recovers the job.
- Review rate-limit thresholds against real traffic.
- Review access to the database, object storage and secrets manager.
- Run the load test in [`docs/load-testing.md`](./docs/load-testing.md) against a
  staging stack, not production.

## 8. Backup and restore

The procedure is in [`docs/backup-restore.md`](./docs/backup-restore.md). The
short version:

1. Take a custom-format `pg_dump` of the source.
2. Restore into an empty scratch database.
3. Compare a content hash for every table.
4. Check the credit invariants and the five idempotency indexes.
5. Never restore over the source.
6. Treat dumps as production data: they contain password hashes and encrypted
   social tokens.

`pnpm backup:check` requires `DATABASE_URL` and `RESTORE_DATABASE_URL`. CI runs the
drill after the integration suite.

## 9. Secret rotation

| Secret                  | Effect of rotation                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `JWT_ACCESS_SECRET`     | Existing access tokens fail verification immediately; clients with a valid refresh session can obtain a new one.         |
| `JWT_REFRESH_SECRET`    | Required by config validation. Rotating it does not revoke stored refresh sessions; revoke those explicitly if required. |
| `TOKEN_ENCRYPTION_KEY`  | Existing social tokens become unreadable. Reconnect accounts or write a re-encryption migration first.                   |
| Provider API keys       | Rotate in the provider, then update the environment and restart the affected worker.                                     |
| Database/S3 credentials | Rotate with overlapping credentials where the provider supports it.                                                      |

After rotating JWT secrets, expect a burst of re-logins. After rotating the token
encryption key without re-encryption, publishing will fail with a decryption
error; that is deliberate and safer than silently using a wrong key.

## 10. Scaling

- Do not run more than one API replica until the rate limiter uses a shared
  store. Today's limiter is per-process; N replicas multiply the effective limit.
- Content, media and publisher workers can scale horizontally.
- Analytics worker and reaper are single-leader. A second replica loses the
  advisory lock and exits cleanly; it is not a hot spare. Use an orchestrator
  restart policy if the leader must be replaced automatically.
- Outbox relay can scale; `SKIP LOCKED` and deterministic job ids handle
  concurrency.
- Watch database connection counts. Each process opens its own pool with a
  default maximum of 10 connections.
- Media workers are CPU-bound; scale on CPU and queue depth, not request rate.

## 11. Known operational gaps

- Readiness is not dependency-aware.
- Worker metrics are process-only; the database-derived gauges come from the API.
- Alertmanager is deployed, but Slack delivery requires `SLACK_WEBHOOK_URL`; the
  local default is a placeholder receiver.
- Grafana panels have not been rendered in this environment.
- Rate limits are per-process.
- Real email, social, AI and billing providers are not connected.
- No production API host exists in the current Vercel deployment.
- There is no replay path for a terminal publish failure. A failed `publish_jobs`
  row cannot be rescheduled; the schedule must be recreated.
- Analytics and reaper have no hot spare: a second instance exits after losing
  the advisory lock.
- No automated backup schedule is in this repository; the operator owns it.
- No WAF or DDoS protection is configured in this repository.
- No on-call rotation or paging integration is in this repository.

These gaps are also listed in [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`SECURITY.md`](./SECURITY.md) and [`DEPLOYMENT.md`](./DEPLOYMENT.md). Fix the
ones that block launch before accepting real customer traffic.
