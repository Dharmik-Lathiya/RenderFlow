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
│   ├── db/                      # Prisma client + migrations
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
| DB            | PostgreSQL 16, Prisma (raw SQL for credit-critical statements)                                                                                          |
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

INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
VALUES ('JOB', :jid, 'job.created', :payload);

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
brand_memory(id, brand_id, kind, content, embedding vector)  -- approved posts for "brand voice"

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

outbox_events(id, aggregate_type, aggregate_id, event_type, payload jsonb, created_at, processed_at, attempts)
notifications(id, user_id, type, title, body, read_at, created_at)
audit_logs(id, actor_id, action, entity, entity_id, meta jsonb, created_at)
```

Indexes: `generation_jobs(status, locked_until)`, `publish_jobs(status, scheduled_for)`, `outbox_events(processed_at) WHERE processed_at IS NULL`, `credit_ledger(user_id, created_at)`.

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
9. **Reconciliation job (hourly):** `wallet.available + reserved == SUM(ledger)`; alert on drift.
10. **Rate limiting:** per-user API limits; per-platform publish limiter.
11. **Token safety:** social tokens encrypted at rest (AES-256-GCM), refresh before expiry.

---

## 10. API surface (REST, prefix `/api/v1`)

```
POST   /auth/register          (grants 50 credits)        POST /auth/login | /auth/refresh | /auth/logout
GET    /me                     GET /credits (balance + ledger, paginated)
POST   /workspaces             GET /workspaces/:id/members
POST   /brands                 GET/PATCH/DELETE /brands/:id
POST   /campaigns              (goal) → creates PLAN job (reserve 2)
GET    /campaigns/:id          GET /campaigns/:id/posts
POST   /posts/:id/generate     (type: caption|poster|carousel|reel) → reserve + job
POST   /posts/:id/regenerate-scene
PATCH  /posts/:id              (edit caption etc.)
POST   /posts/:id/approve      POST /posts/:id/schedule {scheduledAt, accountIds[]}
POST   /posts/:id/cancel-schedule
GET    /jobs/:id               GET /jobs/:id/events   (SSE live progress)
GET    /social-accounts        POST /social-accounts/connect/:platform   (OAuth)
GET    /analytics/campaigns/:id
GET    /notifications          PATCH /notifications/:id/read
Admin: GET /admin/dlq  POST /admin/dlq/:id/replay  POST /admin/credits/adjust  GET /admin/reconcile
Health: GET /health/live  /health/ready   Metrics: GET /metrics
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
- **Prisma:** migrations in `libs/db/prisma/migrations`; credit-critical queries use `$queryRaw`/`$executeRaw` inside `$transaction`.

---

## 12. Phases (end to end)

Each phase ends with a **Definition of Done (DoD)**. Do not start the next phase until the DoD passes.

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

### Phase 3: Brands, campaigns, posts, assets (CRUD)

- Workspaces, members/roles, brands (tone, colors, audience), campaigns, posts, asset upload via presigned S3 URLs.
- **DoD:** role permissions enforced; assets upload and download; OpenAPI docs generated.

### Phase 4: Job pipeline with mock AI

- `generation_jobs`, `job_checkpoints`, outbox + relay, content-worker + media-worker with **mock providers** (`sleep` + dummy files).
- Stage machine PLAN→SCRIPT→IMAGE→VOICE→RENDER, SSE progress endpoint.
- Reserve on request, capture on success, refund on failure.
- **DoD:** creating a reel job reserves 30, progresses through all stages visible via SSE, ends with capture; forced failure ends with refund.

### Phase 5: Reliability layer

- Heartbeat/lease, reaper, retries with backoff, checkpoint resume, DLQ, graceful shutdown, idempotency keys.
- **DoD:** killing `media-worker` at stage IMAGE results in retry on another worker that resumes from checkpoint; after max attempts the job fails and credits are refunded exactly once; chaos test passes.

### Phase 6: Real AI integration

- LLM provider with Zod-validated structured output (plan, caption, script/scenes).
- Image and TTS providers, FFmpeg stitching with subtitles and brand watermark.
- Moderation check before reserve. Brand voice memory (embed approved posts in pgvector and inject into prompts).
- Provider fallback and per-provider timeouts and rate limits.
- **DoD:** end-to-end real generation of caption, poster, and a 15 s reel works with provider keys; switching `AI_PROVIDER=mock` still passes the whole test suite.

### Phase 7: Scheduling and publishing

- Approval workflow (EDITOR submits → APPROVER approves).
- `schedule` creates `publish_jobs` and BullMQ delayed jobs (also persisted in DB so Redis loss is recoverable).
- Social adapters: `mock`, `linkedin`, `instagram` (container/publish flow).
- OAuth connect, token encryption/refresh, platform formatting rules, publish rate limiter.
- Idempotent publish (check external post before retry), failure notifications (in-app + email).
- **DoD:** scheduled post publishes within 5 s of target time; killing `publisher-worker` mid-publish never creates a duplicate post; token-expired path refreshes and succeeds.

### Phase 8: Frontend (Next.js)

- Auth pages, onboarding (brand setup), dashboard with credit balance.
- Campaign wizard (goal → AI plan), calendar (drag to reschedule), post editor with platform preview, asset library.
- Live job progress (SSE), notifications center, insufficient-credits upsell modal, analytics page.
- **DoD:** the full user journey runs in the browser; accessible (keyboard + labels); responsive on mobile.

### Phase 9: Analytics, admin, observability

- Analytics worker pulling metrics; campaign dashboard; "what to post next" AI suggestions.
- Admin: DLQ viewer/replay, manual credit adjustment (audited), reconciliation report.
- Prometheus metrics: queue depth, job duration, failure rate, refund count, ledger drift; Grafana dashboards; Bull Board.
- **DoD:** dashboards show live data; alerts defined for stuck jobs, DLQ growth, ledger drift.

### Phase 10: Hardening and launch polish

- Security pass (OWASP, secrets, CORS, helmet, CSRF for cookies, upload validation, SSRF checks).
- Load test (k6), indexes review, backup/restore doc.
- README with architecture diagram, **chaos demo GIF**, setup guide.
- Optional: Razorpay/Stripe top-ups with webhook and idempotent `PURCHASE` ledger entries.
- **DoD:** all test layers green in CI; load test targets met; README lets a stranger run the demo in 10 minutes.

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
- Metrics: `jobs_total{status}`, `job_duration_seconds{stage}`, `queue_depth{queue}`, `credits_refunded_total`, `ledger_drift`, `publish_failures_total{platform}`.
- Alerts: stuck jobs > 5 min, DLQ > 0, drift ≠ 0, publish failure rate > 10%.
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
