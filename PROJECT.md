# RenderFlow: AI Marketing Studio and Scheduler

> Business enters brand details and a goal. AI generates a campaign (captions, posters, reels/videos), the user approves it, and a worker auto-publishes it to social platforms at the scheduled time. Usage is credit based: **every new user gets 50 free credits**, credits are reserved before work starts and refunded automatically if generation fails.

---

## 1. Goals and non-goals

**Goals**

- Reliable: a crash at any point must never lose a job, double charge, or double post.
- Credit safe: auditable ledger, atomic reserve, idempotent refund.
- Decoupled: API and heavy work are separated by queues and events.
- Demo-able: one `docker compose up` runs everything, plus a chaos script that kills a worker mid-job.

**Non-goals (v1)**

- Not full microservices. Not every social platform (Instagram + LinkedIn real or mocked, others later).
- No payments in v1 (a stub "top-up" endpoint is enough; Stripe/Razorpay is Phase 10).

---

## 2. Architecture decision

**Modular monolith (NestJS API) + separate worker processes, connected by Redis/BullMQ queues and an outbox.**

Why not microservices: credits need atomic DB transactions, solo developer, faster build, easier demo. Modules communicate via events so any module can be extracted later.

```
                        ┌─────────────────────────────┐
                        │  Next.js Web (App Router)   │
                        │  dashboard, calendar,       │
                        │  editor, live progress(SSE) │
                        └──────────────┬──────────────┘
                                       │ REST + SSE
                        ┌──────────────▼──────────────┐
                        │   NestJS API (monolith)     │
                        │ auth | brands | campaigns   │
                        │ credits | assets | schedule │
                        │ social-accounts | analytics │
                        │ notifications | admin       │
                        └───┬─────────────────────┬───┘
                            │                     │
                  ┌─────────▼────────┐   ┌────────▼─────────┐
                  │  PostgreSQL      │   │ Redis            │
                  │  (source of      │   │ BullMQ queues    │
                  │   truth + outbox)│   │ + pub/sub        │
                  └─────────▲────────┘   └────────┬─────────┘
                            │                     │
     ┌──────────────────────┴──┬───────────┬──────┴─────┬──────────────┐
     │                         │           │            │              │
┌────▼─────┐ ┌─────────────┐ ┌─▼────────┐ ┌▼──────────┐ ┌▼───────────┐ ┌▼─────────┐
│ outbox-  │ │ content-    │ │ media-   │ │ publisher │ │ analytics- │ │ reaper   │
│ relay    │ │ worker      │ │ worker   │ │ worker    │ │ worker     │ │ (cron)   │
│          │ │ (LLM: plan, │ │ (image,  │ │ (post to  │ │ (pull      │ │ stuck    │
│          │ │ captions)   │ │ voice,   │ │ platforms)│ │ metrics)   │ │ jobs,    │
│          │ │             │ │ FFmpeg)  │ │           │ │            │ │ refunds  │
└──────────┘ └─────────────┘ └────┬─────┘ └───────────┘ └────────────┘ └──────────┘
                                  │
                          ┌───────▼────────┐
                          │ S3 / MinIO     │
                          │ assets, videos │
                          └────────────────┘
```

### Components

| Component          | Responsibility                                                                           | Scales by                                     |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| `web`              | UI                                                                                       | replicas                                      |
| `api`              | Auth, validation, credit reserve, job creation, reads, SSE                               | replicas behind LB                            |
| `outbox-relay`     | Reads `outbox_events` from DB and pushes to BullMQ (guarantees DB and queue consistency) | 1-2 instances (uses `FOR UPDATE SKIP LOCKED`) |
| `content-worker`   | LLM calls: content plan, captions, hashtags, scripts                                     | queue depth                                   |
| `media-worker`     | Image gen, TTS, FFmpeg render                                                            | queue depth (CPU/GPU heavy)                   |
| `publisher-worker` | Publishes at scheduled time, retries, token refresh                                      | queue depth                                   |
| `analytics-worker` | Periodically pulls platform metrics                                                      | cron                                          |
| `reaper`           | Detects dead jobs, retries or fails + refunds, re-enqueues orphaned PENDING              | 1 instance (leader lock)                      |

---

## 3. Monorepo structure

```
renderflow/
├── AGENTS.md
├── PROJECT.md
├── docker-compose.yml
├── .env.example
├── package.json                 # pnpm workspaces
├── pnpm-workspace.yaml
├── turbo.json
├── apps/
│   ├── web/                     # Next.js
│   ├── api/                     # NestJS modular monolith
│   │   └── src/modules/
│   │       ├── auth/ users/ brands/ campaigns/ posts/
│   │       ├── credits/ jobs/ assets/ schedule/
│   │       ├── social-accounts/ analytics/
│   │       ├── notifications/ admin/ outbox/
│   ├── content-worker/
│   ├── media-worker/
│   ├── publisher-worker/
│   ├── analytics-worker/
│   ├── outbox-relay/
│   └── reaper/
├── libs/
│   ├── common/                  # DTOs, enums, event contracts, queue names, zod schemas
│   ├── db/                      # Drizzle schema, client, migrations
│   ├── credits/                 # ledger logic (the ONLY place that touches wallets)
│   ├── queue/                   # BullMQ factories, retry presets
│   ├── storage/                 # S3 abstraction
│   ├── ai/                      # LLM, image, TTS provider interfaces + mock providers
│   ├── social/                  # platform adapters (instagram, linkedin, mock)
│   └── observability/           # pino logger, metrics, tracing
├── packages/
│   └── api-client/              # typed SDK generated from the NestJS OpenAPI document
├── infra/
│   ├── docker/                  # Dockerfiles per app
│   ├── grafana/ prometheus/
│   └── scripts/                 # chaos.sh, seed.ts
└── tests/
    ├── e2e/                     # Playwright
    ├── integration/
    └── chaos/
```

### 3.1 Client SDK and future mobile support

`apps/api` is the only HTTP surface and it is versioned at `/api/v1`. To keep a future
native mobile app cheap, the typed client is **not** generated inside `apps/web` but lives in
`packages/api-client` and is generated from the NestJS OpenAPI document:

- `packages/api-client` — generated types + a thin fetch wrapper. Built by `pnpm gen:api-client`
  from the API's `/api/v1-json` document, then type-checked in CI.
- `apps/web` consumes `@renderflow/api-client`.
- A future `apps/mobile` (React Native / Expo) consumes the **same** package.

Rules that keep this honest:

- The client is generated, never hand-edited. A CI contract test fails if the committed output
  differs from the current OpenAPI document.
- Any breaking change to `/api/v1` requires a new version prefix (`/api/v2`), because published
  mobile binaries cannot be force-upgraded.
- Auth uses httpOnly cookies for the web app; mobile uses the same endpoints with a bearer token
  issued to the token store. Both are supported by `POST /auth/login`.

---

## 4. Tech stack

| Layer         | Choice                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend      | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query, FullCalendar or dnd-kit, SSE                                                     |
| API           | NestJS, TypeScript (strict), class-validator or zod, Swagger/OpenAPI                                                                                    |
| DB            | PostgreSQL 16, Drizzle ORM (raw SQL for credit-critical statements)                                                                                     |
| Queue         | Redis 7 + BullMQ (flows, delayed jobs, rate limiters)                                                                                                   |
| Storage       | S3 (MinIO locally)                                                                                                                                      |
| AI            | LLM: Claude or OpenAI (structured JSON, Zod validated). Images: Replicate/fal.ai. TTS: ElevenLabs/OpenAI. **All behind interfaces with a MockProvider** |
| Video         | FFmpeg                                                                                                                                                  |
| Auth          | JWT access + refresh (httpOnly cookies), argon2 hashing, OAuth for social accounts                                                                      |
| Observability | pino, Prometheus, Grafana, Bull Board, OpenTelemetry (optional)                                                                                         |
| Tests         | Jest, Supertest, Testcontainers, Playwright, k6                                                                                                         |
| DevOps        | Docker Compose, GitHub Actions                                                                                                                          |

---

## 5. Credit system

### 5.1 Rules

1. **Signup bonus: 50 credits**, granted once per user, inside the same DB transaction that creates the user. Unique constraint `(user_id, type)` where `type = SIGNUP_BONUS` prevents duplicates.
2. Wallet has two numbers: `available` and `reserved`.
3. **Reserve before work.** Starting any paid generation moves credits `available → reserved` atomically with job creation. If `available < cost`, reject with `402 INSUFFICIENT_CREDITS` and create nothing.
4. **Capture on success.** `reserved` is released (credits are spent).
5. **Refund on failure.** After max retries or a permanent system error, `reserved → available` (idempotent).
6. **Partial failure:** each paid asset is its own line item. Refund only the failed items.
7. **User fault** (policy-violating prompt, caught by moderation _before_ reserve) costs nothing because it is rejected up front. **System fault** always refunds.
8. Publishing and scheduling are free. Only AI generation costs credits.
9. **Every movement is an append-only ledger row.** `wallet.available` and `wallet.reserved` are caches, and a reconciliation job verifies they equal the ledger sums.
10. Every ledger insert is idempotent via unique key `(reference_type, reference_id, entry_type)`.

### 5.2 Pricing table (configurable in DB `pricing_rules`)

| Action                        | Credits |
| ----------------------------- | ------- |
| Content plan (7-day calendar) | 2       |
| Caption + hashtags set        | 1       |
| Poster / photo (1 image)      | 5       |
| Carousel (up to 5 images)     | 15      |
| Reel / video up to 15 s       | 30      |
| Reel / video 16-30 s          | 50      |
| Regenerate a single scene     | 8       |
| Translation of a caption      | 1       |

50 free credits ≈ 1 reel + a few captions, or ~10 posters. Good for a demo.

### 5.3 Ledger entry types

`SIGNUP_BONUS`, `PURCHASE`, `RESERVE`, `CAPTURE`, `REFUND`, `ADJUSTMENT` (admin), `EXPIRY` (optional)

### 5.4 Reserve (atomic)

```sql
BEGIN;

UPDATE wallets
SET available = available - :cost,
    reserved  = reserved  + :cost,
    updated_at = now()
WHERE user_id = :uid AND available >= :cost;
-- 0 rows affected  -> ROLLBACK, return 402

INSERT INTO generation_jobs (id, user_id, kind, status, credits_reserved, idempotency_key, payload)
VALUES (:jid, :uid, :kind, 'PENDING', :cost, :idem, :payload);

INSERT INTO credit_ledger (user_id, entry_type, amount, reference_type, reference_id)
VALUES (:uid, 'RESERVE', -:cost, 'JOB', :jid);

INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, dedupe_key, payload)
VALUES ('JOB', :jid, 'job.created', 'JOB:'||:jid||':job.created', :payload);

COMMIT;
```

### 5.5 Refund (idempotent)

```sql
BEGIN;

UPDATE generation_jobs
SET status = 'FAILED', refunded = true, finished_at = now()
WHERE id = :jid AND refunded = false AND status <> 'COMPLETED';
-- 0 rows -> already refunded or completed -> COMMIT with no-op

UPDATE wallets
SET reserved = reserved - :cost, available = available + :cost
WHERE user_id = :uid;

INSERT INTO credit_ledger (user_id, entry_type, amount, reference_type, reference_id)
VALUES (:uid, 'REFUND', :cost, 'JOB', :jid);   -- unique(reference_type, reference_id, entry_type)

INSERT INTO outbox_events (..., 'credits.refunded', ...);
COMMIT;
```

### 5.6 Capture

Same pattern: guarded `UPDATE generation_jobs SET status='COMPLETED' WHERE status IN ('PROCESSING') AND refunded=false`, then `reserved = reserved - cost`, ledger `CAPTURE` row.

### 5.7 Credit state diagram

```
 signup ──► available:50
 reserve(30) ──► available:20, reserved:30
 success ──► reserved:0            (CAPTURE)
 failure ──► available:50, reserved:0   (REFUND)
```

---

## 6. Data model (PostgreSQL)

```
users(id, email, password_hash, name, role, created_at)
wallets(user_id PK, available int CHECK>=0, reserved int CHECK>=0, updated_at)
credit_ledger(id, user_id, entry_type, amount, reference_type, reference_id, created_at,
              UNIQUE(reference_type, reference_id, entry_type))
pricing_rules(action PK, credits, active)

workspaces(id, name, owner_id)
workspace_members(workspace_id, user_id, role)            -- OWNER | EDITOR | APPROVER | VIEWER
brands(id, workspace_id, name, industry, tone, audience, colors jsonb, logo_asset_id, languages text[])
-- approved posts for "brand voice". Phase 6 builds this with a jsonb embedding
-- rather than `vector`: pgvector is not installed in this environment, so a
-- `vector` column could neither be created nor tested. The store sits behind an
-- interface; see section 12 Phase 6.
brand_memory(id, brand_id, kind, content, embedding jsonb)

campaigns(id, brand_id, goal, status, start_date, end_date, created_by)
posts(id, campaign_id, brand_id, type, caption, hashtags, status, approved_by, scheduled_at, version)
    -- status: DRAFT | GENERATING | READY | APPROVED | SCHEDULED | PUBLISHING | PUBLISHED | FAILED
assets(id, post_id, type, storage_key, mime, duration_ms, width, height, meta jsonb)

generation_jobs(id, user_id, post_id, kind, status, stage, credits_reserved, refunded bool,
                attempts, max_attempts, worker_id, heartbeat_at, locked_until,
                idempotency_key UNIQUE, payload jsonb, result jsonb, error, created_at, finished_at)
    -- status: PENDING | PROCESSING | COMPLETED | FAILED | CANCELLED
    -- stage:  PLAN | SCRIPT | IMAGE | VOICE | RENDER | DONE
job_checkpoints(job_id, stage, output_ref, created_at, PRIMARY KEY(job_id, stage))

social_accounts(id, workspace_id, platform, external_id, access_token_enc, refresh_token_enc, expires_at, status)
publish_jobs(id, post_id, social_account_id, status, attempts, scheduled_for, published_at,
             external_post_id, idempotency_key UNIQUE, error)
    -- status: SCHEDULED | QUEUED | PUBLISHING | PUBLISHED | FAILED | CANCELLED
post_metrics(id, publish_job_id, likes, comments, reach, clicks, fetched_at)

outbox_events(id, aggregate_type, aggregate_id, event_type, dedupe_key, payload jsonb, created_at, processed_at, attempts)
notifications(id, user_id, type, title, body, read_at, created_at)
audit_logs(id, actor_id, action, entity, entity_id, meta jsonb, created_at)
```

Indexes: `generation_jobs(status, locked_until)`, `publish_jobs(status, scheduled_for)`, `outbox_events(created_at) WHERE processed_at IS NULL`, `outbox_events(dedupe_key) UNIQUE`, `credit_ledger(user_id, created_at)`.

`dedupe_key` is the identity of the EVENT, and it is a column rather than a
derived index because the composite `(aggregate_type, aggregate_id, event_type)`
cannot express "one job emits five `job.stage_completed` events" — stage two is a
unique-index violation. Writers supply it: `JOB:<id>:job.created`,
`JOB:<id>:job.stage_completed:<stage>`. See §12 Phase 4.

---

## 7. Job state machines

**Generation job**

```
PENDING ─► PROCESSING(stage: PLAN→SCRIPT→IMAGE→VOICE→RENDER) ─► COMPLETED
   ▲              │ worker dies / error
   └── retry ◄────┤ (attempts < max, exponential backoff)
                  └─► FAILED (attempts exhausted) ─► REFUND
```

**Publish job**

```
SCHEDULED ─► QUEUED (delayed job fires) ─► PUBLISHING ─► PUBLISHED
                                              │ transient error: retry w/ backoff (max 5)
                                              │ token expired: refresh then retry
                                              └─► FAILED ─► notify user (email + in-app)
```

---

## 8. Queues and events

**Queues (BullMQ)**: `content`, `media`, `publish`, `analytics`, `notifications`, `dlq`

| Queue     | Concurrency   | Attempts | Backoff                                          |
| --------- | ------------- | -------- | ------------------------------------------------ |
| content   | 5             | 3        | exponential, 5s base                             |
| media     | 2 (CPU heavy) | 3        | exponential, 15s base                            |
| publish   | 10            | 5        | exponential, 30s base, rate limiter per platform |
| analytics | 3             | 3        | fixed 60s                                        |

**Domain events** (via outbox): `user.registered`, `job.created`, `job.stage_completed`, `job.completed`, `job.failed`, `credits.reserved`, `credits.refunded`, `post.approved`, `post.scheduled`, `post.published`, `post.publish_failed`.

**Routing by stage.** A generation job crosses both queues. `job.created` opens it
on `content`; each `job.stage_completed` routes to the queue that owns the stage
just finished, so `PLAN`/`SCRIPT` go to `content` and `IMAGE`/`VOICE`/`RENDER` go
to `media`. This is the hand-off between content-worker and media-worker: neither
app imports the other, and neither knows the other's stages. The split follows the
shape of the work — an LLM call is mostly waiting on a socket, a render is CPU
bound — which is why `media` runs at concurrency 2.

A worker that receives a job whose _first missing stage_ it does not own does
nothing and returns; it does not skip ahead. Rendering from a script that does not
exist yet produces a broken asset that still costs the user the full price.

---

## 9. Reliability mechanisms (the core value of the project)

1. **Transactional outbox:** DB write and event are one transaction. `outbox-relay` pushes to BullMQ and marks `processed_at`. If Redis is down, events wait in DB.
2. **Heartbeat + lease:** worker sets `locked_until = now()+2m`, renews every 30 s.
3. **Reaper (every 60 s, leader-locked):**
   - `PROCESSING` and `locked_until < now()` → retry or fail + refund.
   - `PENDING` older than 2 min with no queue entry → re-enqueue.
   - `publish_jobs` stuck in `PUBLISHING` → reconcile with platform before retrying.
4. **Checkpointing:** each stage stores output in S3 and `job_checkpoints`; retries resume at the first incomplete stage.
5. **Idempotency:** request `Idempotency-Key` header; unique `publish_jobs.idempotency_key`; ledger unique key; before posting, check `external_post_id` / platform for an existing post.
6. **Saga/compensation:** on permanent failure → refund credits, delete temp files, notify.
7. **DLQ + admin replay:** exhausted jobs land in `dlq`; admin UI can inspect and replay.
8. **Graceful shutdown:** on SIGTERM stop consuming, finish or release the current job back to the queue.
9. **Reconciliation job (hourly):** per-bucket ledger comparison; alert on drift. See the correction below.
10. **Rate limiting:** per-user API limits; per-platform publish limiter.

### 5.10 Reconciliation invariant (corrected)

An earlier revision of this document stated the invariant as

```
wallet.available + wallet.reserved == SUM(credit_ledger.amount)
```

**That is arithmetically impossible with a single signed `amount` column, and this
document's own section 5.4 SQL is what makes it so.** A reservation moves credits
_between_ the two buckets without changing what the user holds, but `RESERVE` is
recorded as `-cost`, so the running sum drops by the cost while
`available + reserved` does not move at all. Measured against Postgres:

| step                   | `available` | `reserved` | wallet total | `SUM(amount)` | stated invariant    |
| ---------------------- | ----------- | ---------- | ------------ | ------------- | ------------------- |
| signup bonus +50       | 50          | 0          | 50           | 50            | holds               |
| reserve 30             | 20          | 30         | 50           | 20            | **fails**           |
| capture 30             | 20          | 0          | 20           | -10           | **fails**           |
| reserve 30 then refund | 50          | 0          | 50           | 50            | holds (coincidence) |

The refund row appearing to satisfy it is an accident of `RESERVE` and `REFUND`
cancelling out, not a property of the system.

**The correct invariant is per bucket**, and it holds exactly:

```
available = SUM(SIGNUP_BONUS, PURCHASE, ADJUSTMENT, REFUND) + SUM(RESERVE, EXPIRY)
reserved  = -SUM(RESERVE, REFUND) + SUM(CAPTURE)
```

The signs do not all match the column names because `RESERVE`, `CAPTURE` and
`EXPIRY` are stored negative (credits leaving the user's holdings) while `REFUND`
is stored positive (credits rejoining them).

Reconciliation compares **per bucket, not on totals**. A wallet that has moved 30
from available to reserved and back has the correct total the entire time while
being wrong in between, so a total-based check would miss a whole class of real
corruption. `libs/credits/src/balance.ts` holds the executable form, and
`tests/integration/credit-engine.spec.ts` (C12) checks it against an independently
written SQL formulation so the two cannot silently agree on a wrong answer.

**Ledger sign convention** (authoritative, used by the whole engine):

| Entry          | Stored sign | Moves                                 |
| -------------- | ----------- | ------------------------------------- |
| `SIGNUP_BONUS` | +           | → available                           |
| `PURCHASE`     | +           | → available                           |
| `ADJUSTMENT`   | ±           | → available                           |
| `RESERVE`      | −           | available → reserved                  |
| `CAPTURE`      | −           | reserved → spent                      |
| `REFUND`       | +           | reserved → available                  |
| `EXPIRY`       | −           | → available (reserved credits expire) |

**Rate limiting — Phase 1 slice (shipped).** `apps/api/src/ratelimit` provides a
global `RateLimitGuard` registered _ahead of_ CSRF and auth, so a refused request
never reaches argon2 (roughly 50ms of CPU per login — the actual denial-of-service
surface). Routes opt in with `@RateLimit({ name, scope })`; scopes are `ip`,
`user` and `email`. Auth endpoints are limited as follows, all configurable via
`RATE_LIMIT_*` (`<count>/<window>`, `0` disables):

| Route                 | Key                  | Default           |
| --------------------- | -------------------- | ----------------- |
| `POST /auth/register` | IP                   | `5/1h`            |
| `POST /auth/login`    | IP + submitted email | `10/15m`, `30/1h` |
| `POST /auth/refresh`  | IP                   | `60/15m`          |

Three deliberate design decisions:

- **The store is in-memory and per-process, behind `RATE_LIMIT_STORE`.** With N
  API instances the effective ceiling is N× the configured limit — a weakening,
  not a hole. Redis is already available (`REDIS_URL`), but making the API's boot
  path depend on it would turn a resilience mechanism into a startup dependency.
  Adding a shared store touches one provider and no call sites. Revisit before
  the first horizontal scale-out.
- **Login carries a per-account limit as well as per-IP.** IP-only cannot stop a
  credential-stuffing run spread across many hosts but aimed at one account. The
  per-account limit is generous on purpose: a tight one is a lockout tool against
  any known address. The right refinement is to count only _failed_ attempts; that
  needs failure-aware accounting, which is not built yet.
- **Fixed window, not sliding.** A caller can burst 2× at a window boundary. Sliding
  windows cost per-key timestamp lists; the trade was judged acceptable for
  credential endpoints and is recorded here rather than left implicit.

Known gap: a body with no usable email falls back to the IP key, so malformed
login requests share one counter. That bounds memory (the point of the fallback)
but means a client sending garbage is charged against its IP's account budget. 11. **Token safety:** social tokens encrypted at rest (AES-256-GCM), refresh before expiry.

---

## 10. API surface (REST, prefix `/api/v1`)

```
Auth:      POST /auth/register (grants 50 credits) | /auth/login | /auth/refresh | /auth/logout
           GET  /auth/me | GET /me
Credits:   GET  /credits (balance + ledger, paginated)
Workspace: GET  /workspaces | GET /workspaces/:id | GET/POST/DELETE /workspaces/:id/members[/:userId]
Brands:    GET/POST /brands | GET/PATCH/DELETE /brands/:id | GET /brands/:id/campaigns
Campaigns: POST /campaigns (goal; reserves 2) | GET /campaigns/:id | GET /campaigns/:id/posts
Posts:     GET/POST /posts (GET filters scheduled posts by workspace and range)
           GET/PATCH /posts/:id | POST /posts/:id/generate | POST /posts/:id/approve
           POST/PATCH/DELETE /posts/:id/schedule | GET /posts/:id/publishes | GET /posts/:id/assets
Jobs:      GET  /jobs/:id | GET /jobs/:id/events (SSE live progress)
Assets:    POST /assets/uploads | POST /assets/:id/confirm | GET /assets/:id/download | DELETE /assets/:id
Social:    GET/POST /social-accounts | DELETE /social-accounts/:id
Notify:    GET  /notifications | GET /notifications/unread-count
           POST /notifications/:id/read | POST /notifications/read-all
Analytics: GET  /analytics/overview?workspaceId=:id | GET /analytics/campaigns/:id
Admin:     GET  /admin/dlq | POST /admin/dlq/:jobId/replay
           GET  /admin/dlq/outbox | POST /admin/dlq/outbox/:eventId/replay
           GET  /admin/reconcile | POST /admin/credits/adjust
Probes:    GET  /health/live | /health/ready | GET /metrics | GET /docs-json
```

Errors use RFC 7807 style: `{ code, message, details }`. Codes include `INSUFFICIENT_CREDITS`, `MODERATION_REJECTED`, `IDEMPOTENCY_CONFLICT`, `ACCOUNT_TOKEN_EXPIRED`.

---

## 11. Configuration

### 11.1 `.env.example`

```env
# General
NODE_ENV=development
LOG_LEVEL=debug

# Database / Redis
DATABASE_URL=postgresql://renderflow:renderflow@postgres:5432/renderflow
REDIS_URL=redis://redis:6379

# Auth
JWT_ACCESS_SECRET=change-me
JWT_REFRESH_SECRET=change-me-too
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
TOKEN_ENCRYPTION_KEY=base64-32-bytes

# Credits
SIGNUP_BONUS_CREDITS=50
MAX_JOB_ATTEMPTS=3
JOB_LEASE_SECONDS=120
HEARTBEAT_SECONDS=30
REAPER_INTERVAL_SECONDS=60

# Storage
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=renderflow-assets
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio12345

# AI providers (use mock locally)
AI_PROVIDER=mock                # mock | anthropic | openai
IMAGE_PROVIDER=mock             # mock | replicate | fal
TTS_PROVIDER=mock               # mock | elevenlabs | openai
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
REPLICATE_API_TOKEN=
ELEVENLABS_API_KEY=

# Social (use mock locally)
SOCIAL_PROVIDER=mock            # mock | real
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
OAUTH_REDIRECT_BASE=http://localhost:3000

# Email / notifications
SMTP_URL=smtp://mailhog:1025
WEB_BASE_URL=http://localhost:3000

# Web
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

### 11.2 `docker-compose.yml` (outline)

```yaml
services:
  postgres:
    {
      image: pgvector/pgvector:pg16,
      environment:
        { POSTGRES_USER: renderflow, POSTGRES_PASSWORD: renderflow, POSTGRES_DB: renderflow },
      ports: ['5432:5432'],
      volumes: [pgdata:/var/lib/postgresql/data],
    }
  redis: { image: redis:7, ports: ['6379:6379'] }
  minio:
    {
      image: minio/minio,
      command: server /data --console-address ":9001",
      ports: ['9000:9000', '9001:9001'],
    }
  mailhog: { image: mailhog/mailhog, ports: ['8025:8025'] }
  api:
    {
      build: { dockerfile: infra/docker/api.Dockerfile },
      env_file: .env,
      ports: ['4000:4000'],
      depends_on: [postgres, redis],
    }
  web: { build: { dockerfile: infra/docker/web.Dockerfile }, env_file: .env, ports: ['3000:3000'] }
  outbox-relay: { build: ..., env_file: .env }
  content-worker: { build: ..., env_file: .env, deploy: { replicas: 2 } }
  media-worker: { build: ..., env_file: .env, deploy: { replicas: 2 } } # includes ffmpeg
  publisher-worker: { build: ..., env_file: .env, deploy: { replicas: 2 } }
  analytics-worker: { build: ..., env_file: .env }
  reaper: { build: ..., env_file: .env }
  prometheus: { image: prom/prometheus }
  grafana: { image: grafana/grafana, ports: ['3001:3000'] }
volumes: { pgdata: {} }
```

### 11.3 Tooling configuration

- **TypeScript:** `strict: true`, path aliases `@renderflow/*` → `libs/*`.
- **ESLint + Prettier + Husky + lint-staged**; commit messages follow Conventional Commits.
- **Turbo** pipeline: `build`, `lint`, `test`, `test:e2e`.
- **CI (GitHub Actions):** install → lint → typecheck → unit → integration (Testcontainers) → build images → e2e (compose up) → upload reports.
- **Drizzle ORM:** schema in `libs/db/src/schema.ts` (TypeScript, type-checked); migrations in `libs/db/drizzle/`; credit-critical statements use tagged `sql` templates inside `db.transaction()`. Partial and unique indexes are declared in the schema, so the credit invariants are version-controlled alongside every other constraint.
- **Vercel:** `vercel.json` at the repository root, plus one project setting that Vercel does not allow in that file. See 11.5.

### 11.5 Deployment (Vercel)

Only `apps/web` is deployed. The API, the workers and the database run under
Docker; the dashboard is a Next.js app that talks to the API over
`NEXT_PUBLIC_API_URL`.

Build settings live in `vercel.json` **in the repository**, so a fresh clone
reproduces the deployment instead of relying on someone's memory of the Vercel
dashboard. `scripts/vercel-setup.sh` applies the one remaining setting and verifies
that no dashboard override is shadowing the file.

`rootDirectory` is the exception, and the reason is a Vercel limitation rather than
a choice:

- `vercel.json` has no `rootDirectory` property. Vercel accepts it only as a
  project setting.
- It is not optional. With `framework: null` and the repository root as the project
  root, Vercel builds successfully — and then serves `404 NOT_FOUND` for every
  route, because the Next.js framework preset is what resolves the app, and it
  resolves relative to `rootDirectory`. An output directory that is not a Build
  Output API bundle is treated as static, which is why the build reports success
  while nothing is routable.

That was measured by deploying both configurations, not inferred: the
zero-dashboard-config build reported "migrations applied successfully" / build
completed, and answered 404. The working configuration keeps `framework: "nextjs"`
with `rootDirectory: apps/web`, and the other three settings in `vercel.json` with
no project-level overrides.

Known limitation, stated rather than hidden: a fresh clone still needs
`vercel link` and one dashboard setting. Until Vercel exposes `rootDirectory` in
`vercel.json`, that cannot be removed from here.

### 11.4 Data layer: Drizzle ORM (decision record)

**Decision:** replace Prisma with Drizzle ORM.

**Why.** The two guarantees the credit system depends on are a partial unique
index (`user_id WHERE entry_type = 'SIGNUP_BONOS'` ... `SIGNUP_BONUS`) and a partial
unique index on `(reference_type, reference_id, entry_type)`. Prisma's schema
language cannot express partial unique indexes, so under Prisma these had to be
hand-written migration SQL that the migration tool cannot diff, cannot carry
forward, and can drop without complaint. A constraint that invisible is a poor
place to keep a money invariant.

Drizzle declares them in TypeScript, so they are type-checked and diffed like
every other constraint. It also drops the native query-engine binary (smaller
images, no platform-specific build step) and avoids the Prisma 7 migration, which
removed `url` from datasource blocks and requires `prisma.config.ts` plus a
driver adapter.

**What does not change.** The credit engine is raw SQL either way (section 5
requires guarded `UPDATE ... WHERE available >= :cost`), so this swap alters no
credit behaviour. The integration suite asserts behaviour, not ORM calls, and
therefore proves equivalence.

**Cost.** Rewrite `libs/db`, both migrations, the credit SQL, and the test
helpers. The suites that gate this (`tests/integration`) run against a real
Postgres and must stay green throughout.

**Status.** Implemented. `libs/db` and `libs/credits` now run on Drizzle; the
Prisma schema, client and migrations are removed.

**Migration cutover.** The two data layers are _not_ schema-compatible, because
`users.id` and `users.updated_at` have no database default under Prisma (the
Prisma client generated both values) while Drizzle relies on `gen_random_uuid()`
and `now()`. An existing database therefore cannot be adopted by running
`pnpm db:migrate`: the Drizzle migration would try to `CREATE TABLE` over tables
that already exist.

Two supported paths:

- **Empty database** (CI, a new developer machine): drop, recreate, then
  `pnpm db:migrate`. This is what the local development database did.
- **Database holding data**: `scripts/db-adopt-legacy.sh <database-url>`. This is
  now implemented and tested, not merely described. It records migration `0000`
  as already applied (it describes exactly what Prisma built), then lets Drizzle
  apply `0001` onwards; migration `0004_legacy_column_defaults` adds the column
  defaults that were missing. Both steps are idempotent.

  Run it against a backup. The script refuses to run on an empty database (use
  `pnpm db:migrate`) or on one that already has Drizzle history, so the two
  mistakes it is most likely to be aimed at fail loudly rather than corrupting
  the history.

  Verified by `tests/integration/legacy-cutover.spec.ts`, which builds a faithful
  Prisma-era schema containing rows, runs the adoption, and asserts that the data
  survives, all 13 tables exist, the column defaults are present, the credit
  CHECK constraints still fire, and the history is recorded. A column-by-column
  schema diff against a freshly migrated database leaves exactly two differences,
  both intentional: `refresh_sessions.token_hash` is `char(64)` rather than
  `varchar(64)` (the change this migration made, and blank-padding is harmless
  for a fixed-length hex digest), and the `UserRole` / `CreditEntryType` enum
  _type names_ remain Prisma's capitalised ones because renaming an enum type
  rewrites dependent columns for no functional gain.

**Also changed by the swap**

- `refresh_sessions.token_hash` is `varchar(64)`, not `char(64)`: a fixed-width
  CHAR is blank-padded, which changes comparison semantics for no benefit.
- `updated_at` uses `$onUpdate`, the equivalent of Prisma's `@updatedAt`. It is
  applied in the application layer, so raw SQL must still set it explicitly -
  noted at each column.

---

## 12. Phases (end to end)

Each phase ends with a **Definition of Done (DoD)**. Do not start the next phase until the DoD passes.

### Phase progress

The single place to look for where the project stands. "Shipped" means the
DoD's assertions are written and passing; "partial" means some of them are not.

| #   | Phase                             | Status                                            | Verified how                                                                                                                                                                                                                             |
| --- | --------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Foundation                        | **Shipped**, one DoD item unverified              | `docker compose up` cannot be run here: no Docker. Everything else verified in CI.                                                                                                                                                       |
| 1   | Auth, users, wallet, signup bonus | **Shipped**, one DoD item unverified              | 11/11 `scripts/smoke-phase1.sh` against a running server. `docker compose up` unverified (no Docker).                                                                                                                                    |
| 2   | Credit engine                     | **Shipped**                                       | 100+ integration assertions against real Postgres (C3-C12), plus per-bucket reconciliation.                                                                                                                                              |
| 3   | Brands, campaigns, posts, assets  | **Shipped**                                       | Integration suite incl. multi-tenant isolation per endpoint.                                                                                                                                                                             |
| 4   | Job pipeline with mock AI         | **Shipped**                                       | 33/33 `scripts/smoke-phase4.sh` + integration suites.                                                                                                                                                                                    |
| 5   | Reliability layer                 | **Partial** - R5 (a real SIGKILL) not implemented | R1-R4 pass via `tests/chaos/run.sh`; R5 reported as SKIP and exits non-zero. Needs Redis.                                                                                                                                                |
| 6   | Real AI integration               | **Partial** - the DoD's first half unverified     | Mock passes everything; the renderer is verified end to end with real ffmpeg; providers via a stub transport. **No real provider key has ever been called.**                                                                             |
| 7   | Scheduling and publishing         | **Shipped**, mocks only                           | DoD met against the mock: publishes within 5 s of target, no duplicate when a publisher dies mid-publish, expired token refreshes and succeeds. **No real adapter, no OAuth flow, no email.**                                            |
| 8   | Frontend (Next.js)                | **Shipped**                                       | 68 jsdom tests in 9 suites plus 14/14 Playwright journeys (Chromium and Pixel 7) against a live API, including generation over SSE and scheduling. Every screen built, including the public landing page and calendar.                   |
| 9   | Analytics, admin, observability   | **Partial** - dashboards never rendered           | Analytics worker + metrics sync (8 integration), workspace/campaign analytics (10), admin console + audited adjust (10), Bull Board and queue depth (14 unit). Alerts and dashboard are drift-tested; no panel has rendered (no Docker). |
| 10  | Hardening and launch polish       | **Partial** - security pass started               | Helmet security headers and an explicit-CORS assertion are in place. No k6 load test, backup/restore guide, chaos R5 or CI audit job yet.                                                                                                |

**7 of 11 phases shipped** (0-4, 7, 8), **4 partial** (5, 6, 9, 10), **0
untouched**.

Phase 7 is counted as shipped because its DoD is met end to end — but only
against a mock platform. Nothing has ever left the process to a real one, so the
guarantee is about our behaviour and not about anyone else's. The detail is in
the phase's own known-gaps list.

What "partial" costs, stated plainly:

- **Phase 5** - the recovery logic is tested against the exact database state a
  `kill -9` leaves behind, and takes the same decisions the real thing does. What
  is untested is the process dying, which needs Redis.
- **Phase 6** - every provider's request and response handling is exercised, and
  the renderer produces real mp4s. What is untested is the behaviour of the live
  APIs: their rate limits, their outages, their price.

### Phase 0: Foundation

- pnpm monorepo, Turbo, TS strict, ESLint, Prettier, Husky, CI skeleton.
- Docker Compose with Postgres, Redis, MinIO, MailHog.
- Shared libs skeleton: `common`, `db`, `queue`, `storage`, `observability`.
- **DoD:** `docker compose up` starts infra; `pnpm build` and `pnpm test` pass on an empty scaffold; CI green.

### Phase 1: Auth, users, wallet, signup bonus

- Register/login/refresh/logout, argon2, JWT cookies, RBAC guard.
- On register: create user + wallet + `SIGNUP_BONUS(+50)` ledger row in one transaction.
- `GET /me`, `GET /credits`.
- **DoD:** new user always has exactly 50 credits; registering concurrently with the same email never grants twice; unit + integration tests pass.

### Phase 2: Credit engine (libs/credits)

- `reserve`, `capture`, `refund`, `adjust`, `getBalance`, `reconcile`.
- Raw SQL guarded updates, unique ledger keys, DB CHECK constraints (no negative balances).
- **DoD:** 100 concurrent reserves against 50 credits never overspend; double refund is a no-op; reconcile reports zero drift.

**Status: engine shipped.** `pricing_rules`, `generation_jobs` and `outbox_events`
added; `reserve`/`capture`/`refund`/`adjust` implemented in `libs/credits`. C3-C12
all covered by `tests/integration/credit-engine.spec.ts` against real Postgres,
including 100 parallel reserves and a concurrent refund race.

Four decisions worth carrying forward:

- **Idempotency is enforced twice.** `generation_jobs.refunded` / `.captured` are
  claimed with a guarded `UPDATE ... WHERE refunded = 0 AND captured = 0`, whose
  row count is the decision; the `(reference_type, reference_id, entry_type)`
  unique index is the backstop. `generation_jobs_not_captured_and_refunded` is a
  CHECK constraint, so even raw SQL cannot record a job as both spent and
  refunded. Ten concurrent refunds produce exactly one.
- **`reserveOnce` wraps `reserve` for HTTP handlers.** A bare `reserve` makes
  concurrent retries of one `Idempotency-Key` fail the guarded UPDATE on _funds_ —
  the winner has already moved the credits — so a client whose first call succeeded
  would be told `402 INSUFFICIENT_CREDITS`. `reserveOnce` re-reads the key outside
  the aborted transaction and returns the original job. Found by the C10 race test,
  not by reading the code.
- **A missing price is a server error, not zero.** `priceFor` throws
  `PRICING_UNAVAILABLE` rather than falling back to a default, because charging a
  guessed amount is how a customer gets billed with no record of why. Prices live
  in `pricing_rules` (never code), and inactive rules are retained so historical
  charges still reconcile.
- **Refund and capture refuse to act on a wallet that disagrees with the job**
  (`LEDGER_DRIFT`). Rolling back leaves the inconsistency visible to
  reconciliation instead of inventing credits.

Known gaps, deliberately deferred: `partialRefund` for per-line-item settlement
(C11 is asserted at the ledger level; the job-level API for multi-item assets
belongs with Phase 3 assets), and job lease/heartbeat columns exist but are not
yet written by anyone — they land in Phase 5.

### Phase 3: Brands, campaigns, posts, assets (CRUD)

- Workspaces, members/roles, brands (tone, colors, audience), campaigns, posts, asset upload via presigned S3 URLs.
- **DoD:** role permissions enforced; assets upload and download; OpenAPI docs generated.

**Status: shipped.** `workspaces`, `workspace_members`, `brands`, `campaigns`,
`posts`, `assets` added (migration `0002_phase3_workspaces`). Every new user gets
a personal workspace they own, created in the same transaction as the account.

Decisions worth carrying forward:

- **Roles are a capability table, not a rank.** `OWNER > EDITOR > APPROVER > VIEWER`
  would let an EDITOR approve, which is the exact thing the split exists to
  prevent: whoever wrote the caption should not be the one who signs it off. So
  `write` and `approve` are disjoint below OWNER, and `roleHas()` is unit-tested
  per combination. A test caught the linear rank doing exactly this.
- **Tenancy is enforced in the service, not a guard.** `AGENTS.md` §10 says to use
  guards for RBAC, and Phase 1 does. Phase 3 cannot use that shape because the
  documented API addresses resources directly (`POST /brands`), so a guard cannot
  know which workspace `/brands/:brandId` belongs to without running the query the
  service runs anyway. `WorkspaceAccessService.scope()` puts the check on the one
  path that issues the tenant-scoped query. Missing and forbidden deliberately
  return the same answer, so ids cannot be probed.
- **Registration creates the personal workspace in the same transaction.** Every
  scoped query needs a membership to check, so a user without one could not create
  a brand and would have no way to find out why.
- **`assets.size_bytes` is not in the §6 sketch but is required.** The client
  streams bytes straight to S3, so the server can only see the object _after_ the
  upload. Declared size is checked before a URL is issued; the real size is read
  back with `headObject` on confirm, and a client that lied is caught there.
- **Campaign dates are `date`, not `timestamptz`,** and are inserted as SQL
  literals. A calendar date has no time of day; `new Date('2026-03-01')` is UTC
  midnight, which becomes the previous day for anyone west of Greenwich.
- **`brand_memory` / pgvector was deliberately deferred here** and built in Phase 6
  against a portable backend, because the extension is still not available. The
  generated OpenAPI _client_ is likewise still hand-written.

Verified by `./scripts/smoke-phase4.sh` against a running server: 33 assertions
covering reserve-on-request, the two-worker split, capture, SSE, tenancy, an
unaffordable second reel and the refund path. It runs the pipeline in-process
because there is no Redis here, so it exercises the HTTP surface and the database
agreeing with each other rather than the queue hop.

Known gap: `POST /workspaces` is specified in §10 but not implemented — every user
gets a personal workspace at registration, and creating additional workspaces is
the natural next endpoint. A test records the 404 rather than leaving it
undocumented.

### Phase 4: Job pipeline with mock AI

- `generation_jobs`, `job_checkpoints`, outbox + relay, content-worker + media-worker with **mock providers** (`sleep` + dummy files).
- Stage machine PLAN→SCRIPT→IMAGE→VOICE→RENDER, SSE progress endpoint.
- Reserve on request, capture on success, refund on failure.
- **DoD:** creating a reel job reserves 30, progresses through all stages visible via SSE, ends with capture; forced failure ends with refund.

**Status: shipped.** `job_checkpoints` added in migration `0005`; migration
`0006` replaces the outbox's dedupe index. New endpoints `POST
/posts/:id/generate`, `GET /jobs/:id`, `GET /jobs/:id/events`. New package
`libs/outbox`: the relay, the `JobPublisher` interface, `BullMqPublisher` and
`InMemoryPublisher`.

DoD verified against a real Postgres (`tests/integration/job-runner.spec.ts`,
`jobs-api.spec.ts`, `worker-handler.spec.ts`, `outbox-relay.spec.ts`): a reel
reserves 30 (`available 20, reserved 30`), checkpoints all five stages in order,
and ends in capture (`reserved 0, available 20`, exactly one `CAPTURE` row); a
forced failure at any stage ends in refund (back to 50, one `REFUND` row); the
wallet still reconciles to zero drift afterwards.

Decisions worth carrying forward:

- **The pipeline is split across the two workers, not run by one of them.**
  `job.created` routes to `content`; each `job.stage_completed` routes to the
  queue that owns the next stage (`queueForJobStage`), so a reel genuinely crosses
  from content-worker to media-worker without either app knowing the other
  exists. The runner takes a `stages` filter and a worker refuses to start unless
  the first missing stage is one it owns — otherwise media-worker would render a
  reel from a script that does not exist yet.
- **Capture only when the whole pipeline is complete.** A content worker that has
  finished SCRIPT has done a third of the work, and charging for the reel the user
  did not get is the obvious failure mode of splitting the pipeline.
- **Checkpoint, stage pointer and hand-off event are written in one transaction.**
  An event pointing at a checkpoint that does not exist hands the next worker a
  job it cannot resume; a checkpoint with no event strands the job halfway with
  credits reserved and nobody left to finish it.
- **`runJob` throws; `failJob` refunds.** Deliberately separate. A `TRANSIENT`
  provider error is retried with the queue's backoff preset and only the _final_
  attempt returns the credits; a `PERMANENT` error refunds immediately.
  `handleGenerationJob` owns that arithmetic, and rethrows either way so BullMQ
  still sees the failure and can move the job to the DLQ.
- **The outbox is at-least-once, and leans on the deterministic job id.** `SKIP
LOCKED` stops two relays grabbing the same row _while both are inside the claim
  transaction_; it does not reserve the row afterwards, because closing that
  window would mean holding a database transaction open across a call to Redis
  (`AGENTS.md` §6). Exactly-once _enqueue_ comes from `generation-<aggregateId>` —
  BullMQ drops the second add. `InMemoryPublisher` therefore dedupes on
  `queue + jobId` so tests measure what production actually does. This one is
  worth re-reading: an earlier version of the test asserted disjoint batches and
  failed roughly one run in five, which is what exposed the over-claim.
- **Outbox dedupe is a column, not a composite index** (migration `0006`). The
  index sketched in §9, `(aggregate_type, aggregate_id, event_type)`, is wrong the
  moment a job emits five `job.stage_completed` events — stage two was a
  unique-index violation. `dedupe_key` carries the natural identity of the _event_
  (`JOB:<id>:job.stage_completed:<stage>`); a column rather than an expression
  index, because a guarantee the migration tool cannot diff is one it can drop.
- **`reserve` needs a `workspaceId` to emit `job.created`.** The envelope schema
  validates it as a uuid, so an event carrying a placeholder would fail validation
  _inside a worker_ rather than on an API error path. Omitting it yields a job
  with no event and nothing to run it, which is why the API path always supplies
  it.
- **`FAIL_EVERY_NTH`, not the `FAIL_RATE` named above.** A random failure rate
  makes a suite flaky, which teaches people to re-run rather than to read the
  failure. Recorded as a deliberate deviation.
- **SSE polls `job_checkpoints` rather than subscribing to an in-process bus.**
  The durable record is the truth, so a client that reconnects gets the whole
  history and it works across API instances.
- **Relay tuning is configuration** (`OUTBOX_BATCH_SIZE`,
  `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS` on `QueueConfig`), not literals
  in the loop, per `AGENTS.md` §12.

- **`pnpm db:seed` did not exist until now, and an unseeded database cannot
  generate anything.** `AGENTS.md` §4 and §11 both list the command; nothing
  implemented it. `pricing_rules` ships empty, and a missing price is _deliberately_
  a hard failure rather than a silent fallback to `DEFAULT_PRICES`
  (`libs/credits/pricing.ts`), so every `POST /posts/:id/generate` 500s. Phase 4
  is the first phase that charges for anything, which is when it became visible.
  The seed lives in `libs/credits/scripts/seed.mjs` — not `libs/db` — because
  pricing is credits' to own, and putting it in `libs/db` would make the two
  import each other. It copies `DEFAULT_PRICES` rather than restating it, and
  seeds nothing else: a seed that inserted a fake account with a balance is a
  balance nobody's tests can reason about.

Known gaps: the BullMQ path (`BullMqPublisher`, both workers' `createWorker`) is
typechecked and unit-tested against a stubbed factory but has never actually been
_run_ — there is no Redis in this environment. Media stages write deterministic
placeholder bytes rather than real images and FFmpeg output; Phase 6 replaces the
providers. The lease/heartbeat columns exist but are unused: that is Phase 5,
along with the reaper that refunds a reservation whose worker was killed
mid-flight.

### Phase 5: Reliability layer

- Heartbeat/lease, reaper, retries with backoff, checkpoint resume, DLQ, graceful shutdown, idempotency keys.
- **DoD:** killing `media-worker` at stage IMAGE results in retry on another worker that resumes from checkpoint; after max attempts the job fails and credits are refunded exactly once; chaos test passes.

**Status: mostly shipped.** `libs/jobs` gained `lease.ts` and `reaper.ts`; the
two generation workers now hold a lease and heartbeat; `apps/reaper` runs the
sweeps under a Postgres advisory lock. New admin endpoints: `GET /admin/dlq`,
`POST /admin/dlq/:jobId/replay`, `GET /admin/dlq/outbox`,
`POST /admin/dlq/outbox/:eventId/replay`, `GET /admin/reconcile`. Already
delivered in earlier phases: retries with backoff (`libs/queue` presets),
checkpoint resume, idempotency keys, graceful shutdown.

DoD verified in `tests/integration/reliability.spec.ts` (27 assertions) and
`tests/chaos/run.sh` (R1-R4, 14 assertions). **R5 is not implemented** — see the
known gaps below.

Decisions worth carrying forward:

- **The durable attempt counter on the job row is authoritative, not BullMQ's
  `attemptsMade`.** The queue's counter lives in Redis, and a Redis restart —
  the exact event the reaper exists for — would reset it and hand every job an
  infinite number of retries. `acquireLease` increments the row, and the refund
  decision reads the row.
- **Every lease mutation is a guarded UPDATE.** Acquire only takes a lease that
  is free or expired; renew is guarded on `worker_id`, so a worker that was
  declared dead, reclaimed, and then woke up cannot extend a lease it no longer
  holds. Without that guard the zombie and the new owner both believe they have
  the job and the reaper can never reclaim it again.
- **The lease is taken AFTER the cheap checks, and only then.** A worker handed
  a job whose next stage it does not own must not bump the attempt counter — a
  healthy two-worker setup would exhaust a three-attempt budget in a minute and
  start refunding jobs that were never broken.
- **`validateLeaseConfig` fails at boot if the heartbeat interval reaches half
  the lease.** A lease that can expire while its holder is still running means
  the reaper hands a live job to a second worker, and both race to capture the
  credits. Not recoverable at runtime, so it never gets to run.
- **The reaper never runs a job.** It hands work back to the queue and lets a
  worker own it; a reaper that rendered reels would need the lease logic it
  exists to police.
- **The DLQ is not a table.** It is the set of jobs and events that were given
  up on: `generation_jobs` rows in `FAILED` with `refunded = 1`, and
  `outbox_events` rows with their attempts spent. Both are already durable and
  already record whether the credits moved. A separate `dead_letters` table would
  duplicate that and introduce a place for the DLQ and the job row to disagree
  about whether a user was refunded.
- **Replay re-charges.** The original attempt was refunded, so a replay
  re-reserves from the owner's wallet and is refused with `INSUFFICIENT_CREDITS`
  if they no longer have it. Re-queuing without that would be a hole any OWNER
  could pull on repeatedly. It also carries the original payload forward, so a
  replay cannot silently produce a cheaper artefact than the one requested.
- **Leader election is a Postgres advisory lock, not Redis.** Redis is already a
  dependency of the reaper's _actions_, but a lock store that is down must not
  stop the process that recovers jobs. Two reapers would not actually conflict —
  every sweep is a guarded UPDATE — so this is about being able to answer "which
  one is doing the work", not about safety.

Bugs the tests caught
---------------------

- **`requeue` refused the jobs it was written for.** Its guard was
  `locked_until IS NULL`, but `findExpiredJobs` finds a job _because_ its lease
  has expired. Every reclaim was rejected; the "never started" case passed, which
  is exactly the kind of partial green that hides this. The guard now re-checks
  expiry (`IS NULL OR < now()`), which also closes the window between the sweep's
  read and the write.
- **`startHeartbeat().stop()` hung every worker.** It cleared the timer but never
  settled the promise the loop was awaiting, so `done` never resolved — and the
  SIGTERM drain awaits it. Found by a 60s test timeout, not by reading.
- **`workerIdForProcess` did not do what its name said.** It generated a random
  suffix per _call_, so no worker could ever renew its own lease. The instance id
  is now generated once per module load.
- **The durable counter was compared against the queue's budget.** With a lease
  configured for one attempt, `attempts >= fallback` refunded every job on its
  first transient failure. Only the row's own `maxAttempts` may shorten it.

Known gaps:

- **R5 — a real SIGKILL — is not implemented.** `tests/chaos/run.sh` runs R1-R4
  against a real database and reports R5 as `SKIP`, exiting non-zero: a chaos
  harness that reports green for what it did not do is worse than none. R1-R4
  reproduce the exact state SIGKILL leaves (PROCESSING, an unrenewed lease,
  partial checkpoints) and take the same recovery decisions the real thing does;
  what they do not exercise is the process dying, which needs Redis.
- **`/admin/*` is not filtered by workspace.** Operators are workspace OWNERs,
  but the queries are global, so an owner sees the whole DLQ. Wrong for a
  multi-tenant product; recorded rather than shipped quietly.
- **Reconciliation runs on demand, not hourly.** The endpoint exists; nothing
  schedules it yet.
- **The DLQ has no UI.** Only the API.

### Phase 6: Real AI integration

- LLM provider with Zod-validated structured output (plan, caption, script/scenes).
- Image and TTS providers, FFmpeg stitching with subtitles and brand watermark.
- Moderation check before reserve. Brand voice memory (embed approved posts in pgvector and inject into prompts).
- Provider fallback and per-provider timeouts and rate limits.
- **DoD:** end-to-end real generation of caption, poster, and a 15 s reel works with provider keys; switching `AI_PROVIDER=mock` still passes the whole test suite.

**Status: shipped except the first half of the DoD.** Real providers for text,
image, TTS and FFmpeg exist behind the interfaces; the factory selects them;
moderation runs before every reservation; brand voice memory retrieves approved
posts and injects them into the prompt.

**The DoD's first half is NOT verified: no generation has been run against a real
provider key.** There is no network access in this environment. What IS verified:
the second half (`AI_PROVIDER=mock` passes everything), the real renderers driven
end to end with real ffmpeg, and every real provider's request/response handling
through a stub transport. See the known gaps below.

Decisions worth carrying forward:

- **Structured output gets exactly one repair turn.** The model is asked for
  JSON, the answer is parsed, validated with zod, and on failure handed the
  schema shape plus the specific issues found. After that it is PERMANENT: a
  model told what is wrong and still wrong has misunderstood the task, and
  another round trip charges the user for the same failure.
- **Fallback never routes around a refusal.** A PERMANENT error stops the chain.
  A moderation decision that a second provider can overrule is not a decision. Each
  provider also gets its OWN retry budget, because three providers at three
  attempts each is nine upstream calls for one job.
- **Three provider variables, not one.** Text, image and TTS are separately
  billable and separately likely to be unavailable; a replica outage should not
  stop captions being written.
- **Moderation runs BEFORE the reservation, not after.** A reservation taken for
  a request that is then refused has to be refunded, and a refund the user never
  needed is a balance that moved for no reason.
- **The local moderation rules cannot be switched off.** The provider-backed check
  is additive; the deterministic list always runs, in every environment, and a
  model can never un-refuse what it found. That is what makes "moderation runs on
  every request" a property of the code rather than of a configuration.
- **Subtitles are a soft track, and the watermark degrades.** Burning subtitles in
  needs libass and a font at a path that differs on every base image; when either
  is missing every reel would fail. The watermark is skipped and REPORTED when no
  font is available, rather than failing the render.
- **Brand memory ships against a portable backend, not pgvector.** The extension
  is not installed in this environment and the image has no package for it, so a
  `vector` column could neither be created nor tested. `VectorStore` is the seam;
  `PortableVectorStore` stores JSON and ranks by cosine in SQL, and the pgvector
  backend is one class plus the migration written down in
  `libs/ai/src/brand-memory.ts`. For a brand's approved posts that is fast enough;
  for a corpus of millions it is not, which is what the HNSW index is for.
- **Approved examples ride inside the untrusted brand block**, not beside it. They
  are the user's own words, so they are exactly as capable of carrying an
  injection as the tone field is.

Bugs the tests caught
---------------------

- **`-shortest` silently dropped the audio stream** when the stills and the
  narration were the same length - which is exactly what a 15 s reel with 15 s
  narration is. ffmpeg returned success and a mute video. Replaced with an
  explicit output duration plus `apad`.
- **The moderation response schema did not match the API.** It parsed for
  `{flagged}` at the top level; OpenAI returns `{results: [...]}`, so every real
  flag would have read as clean. The unit test passed because it was fed the
  shape the code expected rather than the shape the API sends.
- **Normalisation defeated the term list.** Replacing punctuation with spaces
  turned `D-o-x-x-i-n-g` into `d o x x i n g`, which does not contain
  `doxxing` - so the one obfuscation a person would actually try walked through.
- **The watermark was drawn after concat**, which would have burned the text into
  every frame for the whole reel.
- **`withTimeout` only rejected if the inner work reacted to the abort signal.** A
  provider that ignored it would hang past its deadline holding a leased job until
  the reaper declared the worker dead.
- **`PortableVectorStore.remove` read `rows[0]`** from a bare DELETE, which
  returns a row count - so it reported "not removed" for rows it had deleted.

Known gaps:

- **No generation has been run against a real provider key.** No network access
  here. The request and response handling is exercised through a stub transport;
  the rate limits, price behaviour and outage characteristics of the real APIs are
  not.
- **R5 (a real SIGKILL) is still not implemented** - it needs Redis. Carried over
  from Phase 5.
- **The pgvector backend is documented, not written.** `PortableVectorStore` is
  the only implementation, and it is the wrong choice at corpus scale.
- **Brand memory is populated by nothing yet.** The store and the retrieval work;
  no code writes a post into memory when it is approved. That belongs with the
  approval flow in Phase 7.
- **`OpenAiEmbedder` is unused by default** - the factory wires the local hash
  embedder, which is deterministic but not semantic. A brand's memory only means
  something once `OPENAI_API_KEY` is present.
- **Provider fallback is per-stage, not per-job.** A reel whose images came from
  two different providers is possible, and the DoD does not say whether that
  should be.

### Phase 7: Scheduling and publishing

- Approval workflow (EDITOR submits → APPROVER approves).
- `schedule` creates `publish_jobs` and BullMQ delayed jobs (also persisted in DB so Redis loss is recoverable).
- Social adapters: `mock`, `linkedin`, `instagram` (container/publish flow).
- OAuth connect, token encryption/refresh, platform formatting rules, publish rate limiter.
- Idempotent publish (check external post before retry), failure notifications (in-app + email).
- **DoD:** scheduled post publishes within 5 s of target time; killing `publisher-worker` mid-publish never creates a duplicate post; token-expired path refreshes and succeeds.

Status: **complete.** 72 tests (50 unit, 68 integration across the three
publishing specs). See the per-phase notes below for what was decided and what
was deliberately not built.

Decisions taken while building it:

- **The database row is the truth; the delayed queue entry is a wake-up.** Both
  exist, as the phase description requires, and they are not equally important.
  `publish_jobs.scheduled_for` decides when a post is due and the publisher
  polls for it, so a delayed BullMQ message lost to a Redis restart costs latency
  rather than the post. The delay is derived from `scheduledAt` **at relay
  time**, not at request time - the relay may publish minutes after the
  transaction commits, and computing the delay from the original request puts
  the message in the queue at the wrong time.
- **Three independent checks back the no-double-post guarantee**: our own
  `external_post_id`, `adapter.findExternalPost(key)` called _before_ every
  publish, and the deterministic idempotency key `renderflow:<publishJobId>`.
  Two live in our state and one at the platform, deliberately - the failure
  being protected against is losing our own state, so a check that lived only
  there would fail exactly when it is needed. `findExternalPost` is on the
  `SocialAdapter` INTERFACE for the same reason: as a duck-typed call it would
  be found missing at the worst possible moment.
- **Platform formatting runs at schedule time, not publish time.** A user who
  approves text is approving it as it will appear.
- **`publish_jobs_post_account_idx` is PARTIAL** over the live states. A plain
  unique index would also block rescheduling after a FAILED publish, which is
  exactly what someone does after a platform outage.
- **APPROVER is the floor for scheduling**, the same as for approval.
  Publishing to a public profile is the most privileged act in the product.

Known gaps:

- **Only the mock adapter exists.** `linkedin` and `instagram` are in the
  `social_platform` enum, in the formatting rules, and in the media policies,
  but there is no real HTTP adapter behind `SocialAdapter` and no OAuth
  authorization-code flow - `POST /social-accounts` receives an already-obtained
  token. The interface is the seam the real adapters plug into; none has been
  written, so no post has gone to a real platform.
- **No email is sent.** Phase 7 says "failure notifications (in-app + email)";
  only the in-app half exists. Mail has different failure modes (bounced
  addresses, unverified domains) and belongs behind its own seam rather than as
  a second thing `NotificationsService` does.
- **Token refresh is deduped per process, not per cluster.**
  `TokenRefresherRegistry` collapses concurrent refreshes inside one worker. Two
  `publisher-worker` processes can still both refresh the same account at the
  same moment; on a platform that rotates refresh tokens the second call fails
  and the account needs reconnecting. A Postgres advisory lock would close it,
  but that means holding a connection open across the platform call, which
  AGENTS.md section 6 forbids. Left as a recorded gap rather than half-solved.
- **The publish rate limits are placeholders** (30/min LinkedIn, 25/min
  Instagram). Real quotas are per app id and were not verifiable from here, so
  they are configuration rather than constants that look authoritative.
- **A post that published to some targets and failed others reads as `FAILED`.**
  `post_status` has no partial state; marking it `PUBLISHED` would hide the one
  account that needs reconnecting, which is the only thing the user can act on.
- **Brand memory is still populated by nothing.** Phase 6 left this open and
  Phase 7 added the approval flow it was waiting for, but wiring approval into
  memory is still not done. This is the one Phase 6 gap Phase 7 was supposed to
  close.

### Phase 8: Frontend (Next.js)

- Auth pages, onboarding (brand setup), dashboard with credit balance.
- Campaign wizard (goal → AI plan), calendar (drag to reschedule), post editor with platform preview, asset library.
- Live job progress (SSE), notifications center, insufficient-credits upsell modal, analytics page.
- **DoD:** the full user journey runs in the browser; accessible (keyboard + labels); responsive on mobile.

Status: **shipped.** The screens, the accessibility semantics and the API
integration are built and tested. The browser suite passes locally against
`pnpm dev` with mock providers: 14/14 across Chromium and a Pixel 7 viewport,
including signup, brand and campaign creation, generation over SSE, approval,
account connection and scheduling.
Screens built: public landing page (light editorial, server-rendered, no app
shell), sign in, register, dashboard (credit balance + brands), brand detail
with the campaign form and campaign analytics, campaign posts, post editor
(generate → approve → schedule), month calendar with drag-to-reschedule and a
date-field fallback, asset library, account settings, notification centre,
workspace analytics overview and the admin console. 68 component tests in 9
suites run under jsdom.

Decisions:

- **The api-client's route map is GENERATED from the OpenAPI document**; the
  response schemas are hand-written. `scripts/generate-api-client.mjs` emits
  `src/generated/routes.ts` from `packages/api-client/openapi.json`, which
  `apps/api/src/openapi-dump.ts` produces. A drift test asserts every path the
  hand-written domain layer calls exists in the generated map, and accounts by
  name and reason for every documented path it deliberately does not call.
- **Response types are hand-written because the document has none.** The API
  validates with zod, and Nest's Swagger plugin reads decorators rather than zod,
  so the document carries zero component schemas. Rather than emit `any`, every
  generated operation's `request`/`response` is `unknown` and the domain layer
  parses with zod. Closing this means giving the API response schemas - an API
  change, deliberately not smuggled into a frontend phase.
- **Accessibility is tested, not asserted.** Buttons are checked on Enter _and_
  Space; `Field` hands the caller `{ id, describedBy, invalid }` together
  precisely so a caller cannot wire two of the three (the first version let
  exactly that happen, and the test caught it); the file input is `sr-only` rather
  than `display: none` so it stays in the tab order.
- **`Providers` takes an optional `queryClient`.** An injection point, not "wrap
  it in your own provider" - a provider outside is shadowed by the one inside,
  so the test's settings silently do not apply.

Known gaps:

- **The browser journey runs against a live API, but the local stack is not
  compose.** This environment has no Docker daemon, so the 14/14 local pass used
  `pnpm dev`, local Postgres/Redis and an S3-compatible test server. CI runs the
  same Playwright suite against the compose stack; `scripts/e2e.sh` still checks
  for Playwright, a browser binary and a reachable app and exits 3 with a SKIP and
  a reason for anything missing, so it cannot report a pass for work it did not do.
- **The calendar drag is tested at the DOM-event level, not in a browser.**
  jsdom dispatches `dragstart`/`dragover`/`drop`; it cannot show the chip landing
  on the target day or a native drag image. Every card also exposes a date field,
  which is the keyboard path and is tested directly.
- **Analytics is snapshot-based.** The overview and campaign pages read
  `post_metrics`, written by the analytics worker. A post published less than
  `ANALYTICS_FIRST_SYNC_MS` ago (five minutes by default) has no row yet, and the
  page shows zeros rather than inventing numbers.
- **The OAuth flow is a token field.** `POST /social-accounts` accepts an
  already-obtained token and the screen labels it as exactly that. The
  authorization-code redirect is Phase 7's outstanding gap, unchanged.
- **The generated client has no response types**, as above. A future consumer
  reading a field the schema does not name will get a strip, not an error.

### Phase 9: Analytics, admin, observability

- Analytics worker pulling metrics; campaign dashboard; "what to post next" AI suggestions.
- Admin: DLQ viewer/replay, manual credit adjustment (audited), reconciliation report.
- Prometheus metrics: queue depth, job duration, failure rate, refund count, ledger drift; Grafana dashboards; Bull Board.
- **DoD:** dashboards show live data; alerts defined for stuck jobs, DLQ growth, ledger drift.

Status: **partial.** Both halves are built and covered by unit, integration and
jsdom tests. The alert rules are defined and drift-tested; the dashboards have
never rendered because there is no Docker in this environment.

Built:

- `MetricsCollector` (libs/observability) derives fourteen business gauges from
  the database on a timer, run by the API through `MetricsCollectorService`;
  every series renamed to carry the `renderflow_` prefix. `BullQueueDepthSource`
  supplies `renderflow_queue_depth` from BullMQ, opening Redis lazily so a
  metrics-disabled deployment pays nothing.
- `analytics-worker` pulls `post_metrics` from the platforms: one snapshot per
  publish job per hour, keyed by `(publish_job_id, fetched_at)` so a retry
  updates instead of duplicating. A Postgres advisory lock elects one leader
  across replicas. The first snapshot is taken five minutes after publication
  and refreshed every six hours (`ANALYTICS_FIRST_SYNC_MS`,
  `ANALYTICS_REFRESH_MS`). Mock by default; `SOCIAL_PROVIDER=real` selects the
  Instagram Graph adapter.
- `GET /analytics/overview` (workspace totals, campaign summaries, daily series)
  and `GET /analytics/campaigns/:id` (per-platform totals, post-type
  performance, derived suggestions). The web app has a workspace overview, a
  campaign analytics panel with an "up next" list, and a month calendar.
- Admin console: DLQ and abandoned outbox views, replay for both, a
  reconciliation report and credit adjustment. An adjustment writes the ledger
  row and its `audit_logs` row in one transaction, is scoped to the operator's
  workspaces (or a global `ADMIN`), and is idempotent on the optional reference
  id.
- Bull Board is opt-in (`BULL_BOARD_ENABLED=false` by default) and admin-only:
  it shows every tenant's job payloads, so a deployment must choose to expose it.
- Eleven alert rules in `infra/prometheus/alerts.yml` and a twelve-panel
  dashboard in `infra/grafana/dashboards/platform.json`, provisioned from git
  with `allowUiUpdates: false`.

Tests: 8 metrics-sync, 10 analytics and 10 admin-adjust integration tests; 29
existing collector and `/metrics` integration tests; 18 jsdom tests across the
overview, campaign analytics, calendar and admin console; unit tests for the
board guard and the queue-depth source.

Decisions:

- **Facts that are properties of a ROW are DERIVED, not counted.** A counter
  incremented in a handler resets when the process restarts and records nothing
  at all while the process is down - so the dashboard goes blank exactly during
  the incident it exists for. `jobs_total`, `credits_refunded_total` and
  `publish_failures_total` were removed for that reason: each was incremented in
  its own unit test and nowhere else, so they existed and always read zero.
- **`collectorOk{section}` is a 1/0 gauge, not a failure counter.** A counter is
  invisible until its first increment, so a section that fails from the moment it
  starts reports no failures at all - the absence of data looks exactly like
  health. It is set on both the success and failure paths.
- **`METRICS_ENABLED` and `METRICS_COLLECTOR_ENABLED` are separate switches.**
  The first controls prom-client's ~20 default PROCESS collectors, the second the
  business gauges. Conflating them means the obvious way to save overhead is also
  switching off the numbers that say whether the product works.
- **The duration percentile is computed in SQL, not by a prom-client histogram.**
  The collector only sees an aggregate, so it observed the batch mean once per
  job per pass; histograms accumulate, so `_count` grew by the job count every 15
  seconds and the buckets described a distribution that never existed.
  `renderflow_job_duration_p95_seconds` is `PERCENTILE_CONT` over the real rows.
- **The dashboard and the alerts are provisioned from git and drift-tested.**
  `infra-metrics.spec.ts` renders every metric and fails on a name no dashboard,
  alert or declared list mentions, and asserts every alert has a `for:` clause -
  an alert without one fires on a single scrape.
- **Metrics sync is an hourly upsert, not an append.** The poll can retry, and a
  leader handover can overlap; both must converge on one row rather than a
  duplicate snapshot. The unique index is the guarantee, not application logic.
- **LinkedIn metrics report "unsupported", not zero.** The adapter would need the
  organization and share URNs, which the publisher does not record. A missing
  number stays distinguishable from a post nobody saw.
- **Suggestions are derived from the campaign's own numbers, not generated by an
  LLM.** They are free (no credit reservation), deterministic (a reload gives the
  same advice) and cite the number they came from. An LLM narrative layer can sit
  on top later; it would have to agree with the ranking underneath.
- **Bull Board bypasses the Nest guard chain**, so it carries its own
  `adminOnly` middleware and is mounted only after `cookieParser`.

Known gaps:

- **No panel has ever rendered.** There is no Docker here, so Prometheus and
  Grafana have never started. What is verified is the metric names, the
  expressions parsed out of the dashboard and alert files, and the values the
  collector writes - not that a chart appears.
- **The real Instagram adapter has never been called.** The mock implements the
  same interface and the request/response handling is tested, but no live token
  has been used. LinkedIn is deliberately unsupported.
- **The `analytics` queue is a wake-up that nothing enqueues yet.** The poll is
  the real schedule, so a freshly published post still gets its first snapshot
  after five minutes. Wiring the publisher to enqueue here would shorten that,
  but the poll is what makes the numbers correct.
- **Snapshots are hourly.** Time-of-day trends inside an hour are not available,
  and the last six hours are refreshed rather than re-fetched.
- **Bull Board's guard is unit-tested, but no test boots the board against a
  real Redis.** Its mount path runs in `pnpm dev` with the flag on; the queue
  payloads it renders are the same ones the admin endpoints already expose.

### Phase 10: Hardening and launch polish

- Security pass (OWASP, secrets, CORS, helmet, CSRF for cookies, upload validation, SSRF checks).
- Load test (k6), indexes review, backup/restore doc.
- README with architecture diagram, **chaos demo GIF**, setup guide.
- Optional: Razorpay/Stripe top-ups with webhook and idempotent `PURCHASE` ledger entries.
- **DoD:** all test layers green in CI; load test targets met; README lets a stranger run the demo in 10 minutes.

Status: **partial.** Much of the security pass is in place: `helmet` headers on
every response (CSP off only because Swagger UI and Bull Board use inline
assets), an explicit CORS allow-list that rejects `*` with cookie auth, a
double-submit CSRF guard, httpOnly + SameSite cookies, argon2 passwords,
AES-256-GCM social tokens, and upload MIME/size validation with a presigned PUT.
Outstanding: the k6 load test and index review, a backup/restore runbook, chaos
scenario R5 (a real SIGKILL), a CI dependency-audit job, SSRF hardening for any
future user-supplied fetch, and the README chaos GIF.

---

## 13. Testing strategy

### 13.1 Test pyramid

| Layer              | Tool                                                          | Scope                                                                    |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Unit               | Jest                                                          | credit math, state machines, pricing, prompt builders, adapters (mocked) |
| Integration        | Jest + Supertest + Testcontainers (real Postgres/Redis)       | modules, SQL guarantees, queue flows, outbox                             |
| Contract           | Zod schemas / OpenAPI diff                                    | API and event shapes                                                     |
| Concurrency        | Jest + Promise.all / k6                                       | race conditions on credits and publishing                                |
| Chaos / resilience | Bash + Docker + Jest                                          | kill workers/Redis/DB mid-flight                                         |
| E2E                | Playwright against `docker compose` stack with mock providers | real user journeys                                                       |
| Load               | k6                                                            | API throughput, queue drain time                                         |
| Security           | ESLint security plugin, `npm audit`, OWASP ZAP baseline       |                                                                          |

### 13.2 Must-pass credit tests

| #   | Scenario                                      | Expected                                                 |
| --- | --------------------------------------------- | -------------------------------------------------------- |
| C1  | Register new user                             | wallet.available = 50; exactly 1 SIGNUP_BONUS ledger row |
| C2  | Register same email twice concurrently        | one user, one bonus                                      |
| C3  | Reserve 30 with 50 available                  | available 20, reserved 30, ledger RESERVE -30            |
| C4  | Reserve 60 with 50 available                  | 402, no job, no ledger row, balance unchanged            |
| C5  | 100 parallel reserves of 10 with 50 available | exactly 5 succeed, balance never negative                |
| C6  | Job success                                   | reserved 0, one CAPTURE row, no refund                   |
| C7  | Job fails after max attempts                  | one REFUND, available restored                           |
| C8  | Refund called twice (reaper + worker race)    | still exactly one REFUND                                 |
| C9  | Refund after capture                          | rejected / no-op                                         |
| C10 | Same `Idempotency-Key` sent twice             | one job, one reserve, same response                      |
| C11 | Partial failure (3 of 5 images ok)            | refund only failed items' cost                           |
| C12 | Reconcile after all above                     | zero drift                                               |

### 13.3 Must-pass reliability / chaos tests

| #   | Scenario                                                        | Expected                                                                                  |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R1  | Kill `media-worker` during RENDER                               | lease expires, reaper resets, another worker resumes from checkpoint, job completes       |
| R2  | Kill worker on every attempt                                    | job FAILED after max attempts, refunded once, user notified                               |
| R3  | Stop Redis, create job, restart Redis                           | outbox relay delivers; job runs; nothing lost                                             |
| R4  | Kill API after DB commit but before response                    | client retries with same idempotency key and gets the same job                            |
| R5  | DB restart during processing                                    | workers reconnect and continue; no duplicate captures                                     |
| R6  | SIGTERM during deploy                                           | worker releases or finishes job; no loss                                                  |
| R7  | Worker completes S3 upload but crashes before DB update         | retry detects existing output and marks COMPLETED without regenerating or double charging |
| R8  | Two reapers running                                             | leader lock ensures single action; no double refund                                       |
| R9  | Publisher killed after platform accepted post, before DB update | retry reconciles via `external_post_id`/platform lookup; no duplicate post                |
| R10 | Platform returns 429/5xx                                        | backoff retries; success eventually; failure after 5 attempts notifies user               |
| R11 | Token expired                                                   | refresh and retry once; if refresh fails, mark account `NEEDS_REAUTH` and notify          |

`tests/chaos/run.sh` automates these with `docker compose kill`/`stop`/`start` and prints PASS/FAIL per scenario.

### 13.4 E2E user journeys (Playwright)

1. **Happy path:** register → see 50 credits → create brand → create campaign → AI plan appears → generate poster → generate reel (live progress) → approve → schedule 1 min ahead → published (mock platform) → analytics visible.
2. **Insufficient credits:** spend down credits → try reel → upsell modal → balance unchanged.
3. **Failure + refund:** set `FAIL_STAGE=IMAGE` → reel fails after retries → UI shows "failed, credits refunded" → balance restored.
4. **Approval workflow:** editor submits, approver approves, viewer cannot.
5. **Publish failure notification:** mock platform returns 500 → retries → final failure → in-app notification and MailHog email.
6. **Reschedule / cancel** via calendar drag.
7. **Crash demo:** during reel generation kill media-worker (via test hook) → UI keeps progress → completes.

### 13.5 Load targets (k6, local compose)

- API p95 < 300 ms for reads at 200 RPS.
- 500 queued jobs drain with 4 workers without lost or duplicate jobs.
- 1000 publish jobs scheduled for the same minute all publish within 60 s, respecting rate limits.

### 13.6 Coverage and CI gates

- `libs/credits` and state machines: **≥ 95%** line and branch coverage.
- Overall: ≥ 80%.
- CI fails on lint, type errors, failing tests, or high-severity audit findings.

---

## 14. Observability checklist

- Structured logs with `requestId`, `userId`, `jobId`, `stage`.
- Metrics, every name carrying the `renderflow_` prefix. The Phase 0 names were
  emitted BARE because only `collectDefaultMetrics` was given the prefix, so a
  dashboard referencing `renderflow_queue_depth` rendered an empty chart against
  a real series called `queue_depth`.
  - **Counters:** none for business facts, deliberately. `jobs_total`,
    `credits_refunded_total` and `publish_failures_total` were removed: each was
    incremented only in its own unit test, so it existed and always read zero.
    Derive the fact from the row instead.
  - **Derived gauges** (`MetricsCollector`, sampled every `METRICS_INTERVAL_MS`):
    `jobs_by_status{status}`, `jobs_in_window`, `job_failure_rate`,
    `job_duration_mean_seconds{stage}`, `job_duration_p95_seconds{stage}`,
    `stuck_jobs`, `credits_refunded_window`, `ledger_drift`,
    `ledger_drift_users`, `ledger_checked_users`, `publish_failures_window`,
    `outbox_pending_events`, `outbox_abandoned_events`,
    `collector_ok{section}`.
  - **Injected:** `queue_depth{queue}`, from a `QueueDepthSource` the API does
    not currently supply (it needs Redis, and `collector.ts` must not depend on
    the BullMQ client).
- Alerts (`infra/prometheus/alerts.yml`, eleven rules, each with a `for:`):
  stuck jobs > 5 min and > 10, outbox abandoned > 0, ledger drift ≠ 0, job
  failure rate > 10% over > 10 jobs, no jobs at all while queues are non-empty,
  queue backlog > 100, publish failures > 0, refund spike > 20/hour, a collector
  section returning 0, and the scrape target being down.
- Dashboards: `infra/grafana/dashboards/platform.json`, twelve panels,
  provisioned from git with `allowUiUpdates: false`.
- Health endpoints: `/health/live`, `/health/ready` (DB, Redis, S3).

---

## 15. Security checklist

- argon2 password hashing, httpOnly + SameSite cookies, CSRF protection, helmet, CORS allow-list.
- Rate limit auth and generation endpoints.
- Validate every input (zod/class-validator); validate upload MIME and size; never trust client-provided prices or costs.
- Encrypt social tokens; never log secrets or tokens.
- Prompt-injection hygiene: treat brand text and scraped content as data; moderate prompts before spending credits.
- Authorization checks on every workspace-scoped query (multi-tenant isolation tests).

---

## 16. Interview talking points

- Why modular monolith + workers over microservices.
- How atomic reserve prevents double spend; why a ledger beats a bare balance.
- Outbox pattern: DB and queue consistency.
- Heartbeat + lease + reaper for crash recovery; checkpoint resume.
- Idempotency at three levels: API, ledger, publishing.
- Chaos demo: kill a worker at 70% and show the recovery and refund.
- When and how you would extract the media worker into a separate Python/GPU microservice.
