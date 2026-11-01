# Architecture Gaps

All known architectural gaps found in `ARCHITECTURE.md §13` and `OPERATIONS.md §11`
after a full review on 2026-11-01. Each gap has its root cause, what breaks in
production because of it, and a concrete fix plan.

These are the gaps that separate a portfolio project from a production system.
Being able to explain each one — and the tradeoff that created it — is exactly
what backend interviewers ask about.

---

## 🔴 Production blockers

---

### ARCH-01 — `/health/ready` has no registered probes

**Source:** `ARCHITECTURE.md §2`, `OPERATIONS.md §2`

**What it means:**
`HealthService` supports registered probes but none are registered. The endpoint
returns `{ "status": "ok", "checks": {} }` unconditionally. PostgreSQL can be
completely down and this endpoint still returns 200.

**Why it was built this way:**
The health module was scaffolded first and the probes were left as a Phase 10 item.
Wiring probes requires an async dependency check inside a NestJS lifecycle hook,
which is slightly more involved than a simple HTTP handler.

**What breaks without it:**

- Railway/Render restarts a running instance before an unhealthy one
- Load balancers send traffic to instances that cannot serve requests
- Monitoring falsely reports the system is healthy during a DB outage

**Fix plan:**

```
apps/api/src/modules/health/health.service.ts
  → registerProbe('db', () => db.execute(sql`SELECT 1`), { timeoutMs: 2000 })
  → registerProbe('redis', () => redis.ping(), { timeoutMs: 2000 })
  → registerProbe('s3', () => storage.headBucket(), { timeoutMs: 3000 })

Return 503 when any probe fails.
Add integration test: mock DB failure → expect 503 from /health/ready.
```

**Effort:** 2–3 hours

---

### ARCH-02 — Worker processes expose no `/metrics` endpoint

**Source:** `ARCHITECTURE.md §13`, `OPERATIONS.md §3`

**What it means:**
Prometheus is configured to scrape `content-worker:4001`, `media-worker:4002`,
`publisher-worker:4003`, `analytics-worker:4004`, `outbox-relay:4005`,
`reaper:4006`. None of those processes start an HTTP server. All those scrape
targets are permanently down.

**Why it was built this way:**
The `libs/observability` library has the pino logger and Prometheus registry,
but starting a metrics HTTP server in each worker was not done — the metric
collection is centralised in the API's collector, which polls the database.

**What breaks without it:**

- Per-worker CPU, memory, queue processing rate, and stage duration are invisible
- `RenderFlowTargetDown` alert fires constantly (expected false positive, per OPERATIONS.md)
- Cannot tell if a specific worker is slow vs the whole queue is slow

**Fix plan:**

```
libs/observability/src/metrics-server.ts  (new file)
  → startMetricsServer(port: number) — starts a minimal HTTP server on /metrics
  → registers: jobs_processed_total, job_duration_seconds histogram, active_jobs gauge

Each worker's main.ts:
  → import { startMetricsServer } from '@renderflow/observability'
  → startMetricsServer(METRICS_PORT)  // from env: CONTENT_WORKER_METRICS_PORT=4001

Update docker-compose.yml to publish those ports.
Update prometheus.yml scrape targets — they already point to the right ports.
```

**Effort:** 4–5 hours

---

### ARCH-03 — No Alertmanager — alerts evaluate but are never delivered

**Source:** `ARCHITECTURE.md §13`, `OPERATIONS.md §3`

**What it means:**
`infra/prometheus/prometheus.yml` references `alertmanager:9093`. There is no
Alertmanager service in `docker-compose.yml`. Alert rules in
`infra/prometheus/alerts.yml` are evaluated by Prometheus, but when they fire
the notification goes nowhere.

**Why it was built this way:**
Alert rules were written, but deploying Alertmanager and connecting it to a
notification channel (Slack, email, PagerDuty) requires credentials and a
running instance that was not available in this environment.

**What breaks without it:**

- `RenderFlowStuckJobs`, `RenderFlowLedgerDrift`, etc. fire silently
- On-call engineer never gets paged
- The whole observability layer is effectively a dashboard-only setup

**Fix plan:**

```
docker-compose.yml:
  → add alertmanager service using prom/alertmanager:v0.26.0

infra/alertmanager/alertmanager.yml:
  → route to Slack webhook (free) using SLACK_WEBHOOK_URL env var

For the demo deployment (Railway):
  → Use Grafana Cloud free tier — it has built-in Alertmanager
  → Or: use Uptime Robot free tier for basic HTTP alerting
```

**Effort:** 2 hours (local), 3 hours (cloud deployment)

---

### ARCH-04 — Rate limiter is per-process (cannot scale API horizontally)

**Source:** `ARCHITECTURE.md §12`, `SECURITY.md §11`

**What it means:**
The NestJS rate limiter stores counters in process memory. Running 2 API replicas
doubles the effective limit. A user who hits replica A 10 times and replica B 10
times has made 20 login attempts but the per-replica limit only counted 10 each.

**Why it was built this way:**
Using a Redis-backed store requires a small library change and the decision to
treat Redis as a required dependency for the API (currently it is optional —
the API can start without Redis if the queue is not needed). This tradeoff was
noted but not resolved.

**What breaks without it:**

- Cannot horizontally scale the API without degrading security controls
- Rate limit for credit purchases, generation, auth are all broken at scale

**Fix plan:**

```
Install: rate-limiter-flexible (Redis backend)
Config: add RATE_LIMIT_STORE=memory|redis to config schema
apps/api/src/modules/rate-limit/rate-limit.module.ts:
  → when RATE_LIMIT_STORE=redis, use RateLimiterRedis with REDIS_URL
  → keep in-memory for RATE_LIMIT_STORE=memory (default in dev)
Update DEPLOYMENT.md: require RATE_LIMIT_STORE=redis for multi-replica deploys
```

**Effort:** 3–4 hours

---

### ARCH-05 — `notifications` queue has a producer but no consumer

**Source:** `ARCHITECTURE.md §7`, `OPERATIONS.md §5.11`

**What it means:**
When a publish fails, `post.publish_failed` is routed to the `notifications`
queue via the outbox. No process consumes that queue. The in-app notification
works because the publisher worker also writes directly to the `notifications`
table — but the queue route is dead weight that wastes outbox events and
misleads any developer reading the code.

**Why it was built this way:**
The notifications queue was declared as a future path for email notifications.
The email provider was never implemented, so the consumer was never written,
but the outbox route was left in place.

**What breaks without it:**

- Outbox events pile up in the `notifications` queue in BullMQ, never processed
- When the attempt budget is exhausted they appear in the abandoned outbox DLQ
- Misleading to anyone reading the outbox routing logic

**Fix plan — two options:**

```
Option A (simpler): Remove the outbox route for post.publish_failed → notifications queue.
  The direct DB write from publisher-worker is sufficient for now.
  When email is added later, restore the outbox route with a real consumer.

Option B (future-proof): Add a thin notification-worker that consumes the queue
  and sends email via the EmailSender interface. Currently EMAIL_PROVIDER=none
  so it sends nothing, but the queue drains cleanly and email can be enabled
  by changing one env variable.
```

**Recommended:** Option B — it completes the design intent and removes the DLQ noise.

**Effort:** 3 hours

---

### ARCH-06 — Analytics worker and reaper have no hot spare

**Source:** `ARCHITECTURE.md §12`, `OPERATIONS.md §10`

**What it means:**
Both `analytics-worker` and `reaper` use a PostgreSQL advisory lock for
single-leader election. A second replica loses the lock and _exits cleanly_
rather than staying alive as a standby. If the leader crashes:

- The orchestrator must detect the exit and restart the process
- Until restart, generation jobs with expired leases are not recovered
- Analytics metrics stop refreshing

**Why it was built this way:**
The advisory lock pattern is correct for preventing double-processing, but
the exit-on-loss strategy means no hot spare. A "stay alive and poll" strategy
was not implemented to keep the code simple.

**What breaks without it:**

- Reaper: crashed workers are not recovered until the reaper process restarts
- Analytics: metrics go stale until the process restarts
- On Railway/Render, restart usually happens within 30s — acceptable for most cases

**Fix plan:**

```
Current behaviour: lose lock → exit (orchestrator restarts)
Better behaviour: lose lock → sleep 30s → try to acquire lock again → loop

apps/reaper/src/main.ts, apps/analytics-worker/src/main.ts:
  → Replace "exit on lock failure" with "poll loop with backoff"
  → This way a single replica is always available without needing 2 instances
```

**Effort:** 2 hours

---

## 🟡 Missing for production

---

### ARCH-07 — No real AI, social, email or billing provider connected

**Source:** `PHASES.md Phase 6`, `OPERATIONS.md §11`

**What it means:**
Every external provider uses the mock implementation:

- `AI_PROVIDER=mock` — text, image, TTS, moderation
- Social adapter is mock — no real OAuth, no real post
- `EMAIL_PROVIDER=none` — sends nothing
- `BILLING_PROVIDER=stub` — blocked in production

**Why it was built this way:**
All provider interfaces are defined and mock implementations are complete.
Real adapters were intentionally deferred — no API keys are available
in this environment, and real provider calls cost money.

**What is needed per provider:**

| Provider                 | Required secrets                        | Work needed                           |
| ------------------------ | --------------------------------------- | ------------------------------------- |
| Anthropic / OpenAI       | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Adapter exists — just set key         |
| Replicate / Fal (images) | `REPLICATE_API_KEY`                     | Adapter exists — just set key         |
| ElevenLabs (TTS)         | `ELEVENLABS_API_KEY`                    | Adapter exists — just set key         |
| Resend (email)           | `RESEND_API_KEY`                        | Need to implement adapter (~3h)       |
| Stripe (billing)         | `STRIPE_SECRET_KEY`                     | Need to implement adapter (~8h)       |
| Instagram / LinkedIn     | OAuth credentials                       | Need OAuth flow + real adapter (~16h) |

**For the demo deployment:**
Keep all providers as mock. The pipeline runs end-to-end with realistic latency
(`MOCK_LATENCY_MS=1500`) and realistic outputs. This is sufficient for interviews.

---

### ARCH-08 — No publish-job replay path for terminal failures

**Source:** `OPERATIONS.md §5.3`, `OPERATIONS.md §11`

**What it means:**
If a `publish_jobs` row reaches `FAILED` status, there is no admin endpoint to
retry it. The only path is to recreate the entire schedule. This is asymmetric
with generation jobs, which have a DLQ replay endpoint.

**Fix plan:**

```
POST /api/v1/admin/publish/:jobId/replay
  → validate: status = FAILED and external_post_id IS NULL
  → reset: status = PENDING, attempts = 0, error = null
  → write audit log
  → emit publish.retry outbox event
```

**Effort:** 2 hours

---

### ARCH-09 — No automated backup schedule

**Source:** `OPERATIONS.md §11`

**What it means:**
`docs/backup-restore.md` and `scripts/backup-restore-check.sh` exist and CI
runs the restore drill. But there is no cron job that actually takes backups.

**Fix plan:**

```
Option A (Neon — recommended for demo): Neon has automatic daily backups on free tier.
Option B (self-hosted): Add a pg_dump cron job as a Railway/Render cron service
  that dumps to S3 daily and retains 7 days.
```

**Effort:** 1 hour (Neon — it is automatic), 3 hours (self-hosted cron)

---

## Summary table

| ID      | Title                               | Severity   | Effort   |
| ------- | ----------------------------------- | ---------- | -------- |
| ARCH-01 | No readiness probes                 | 🔴 Blocker | 3h       |
| ARCH-02 | Workers have no /metrics            | 🔴 Blocker | 5h       |
| ARCH-03 | No Alertmanager                     | 🔴 Blocker | 3h       |
| ARCH-04 | Rate limiter is per-process         | 🔴 Blocker | 4h       |
| ARCH-05 | Notifications queue has no consumer | 🔴 Blocker | 3h       |
| ARCH-06 | Analytics/reaper have no hot spare  | 🟡 Medium  | 2h       |
| ARCH-07 | No real providers connected         | 🟡 Medium  | Variable |
| ARCH-08 | No publish-job replay               | 🟡 Medium  | 2h       |
| ARCH-09 | No automated backup                 | 🟡 Medium  | 1-3h     |

---

## Interview talking points

These gaps are not failures — they are **deliberate tradeoffs** with documented
reasons. In an interview, explaining _why_ a gap exists is more impressive than
pretending it does not:

> "The rate limiter is in-process because the API currently runs as a single
> replica. I documented that you must not scale to multiple replicas without
> switching to a Redis-backed store first — and I have the fix already designed
> in ARCH-04. The tradeoff was: faster to ship with in-memory, and the constraint
> is explicit rather than hidden."

> "The readiness probe returns empty checks because wiring async health checks
> into NestJS's lifecycle requires a specific pattern I noted but left for the
> hardening phase. The `/health/live` endpoint is correct. The ready endpoint is
> the gap."

> "I know the workers don't expose metrics. That's why Prometheus has those
> scrape targets listed as 'expected down' in OPERATIONS.md — it's a known gap,
> not a misconfiguration I missed."
