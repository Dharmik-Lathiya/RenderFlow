# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, etc.) working on **RenderFlow**.
Read this file fully before making any change. Then read `PROJECT.md` for architecture, credit rules, phases, and tests.

---

## 1. Project summary

RenderFlow is an AI marketing studio and scheduler. Users create brands and campaigns, AI generates captions, posters, and reels, and workers publish approved posts to social platforms on schedule. Usage is **credit based**: new users get **50 free credits**; credits are reserved before work and refunded on failure.

Architecture: **modular monolith (NestJS) + decoupled workers (BullMQ) + transactional outbox**. Not microservices.

---

## 2. Source of truth and workflow

1. `PROJECT.md` is the source of truth. If code and the spec disagree, stop and flag it; do not silently diverge.
2. Work **one phase at a time**, in order (Phase 0 → 10). Do not start a phase until the previous Definition of Done (DoD) passes.
3. Before coding a task: state the plan in a few lines (files to touch, tests to add).
4. After coding: run `pnpm lint && pnpm typecheck && pnpm test`. Fix failures before reporting done.
5. Make small, focused commits using Conventional Commits (`feat(credits): ...`, `fix(publisher): ...`, `test(chaos): ...`).
6. Update docs (`PROJECT.md`, README, OpenAPI) in the same change when behavior changes.
7. If requirements are ambiguous, make the smallest reasonable assumption, write it down in the PR/commit notes, and continue. Ask only when a wrong guess would be costly (security, money, data loss).

---

## 3. Repository layout

```
apps/web                Next.js frontend
apps/api                NestJS modular monolith (all HTTP)
apps/content-worker     LLM tasks
apps/media-worker       image, TTS, FFmpeg
apps/publisher-worker   social publishing
apps/analytics-worker   metrics sync
apps/outbox-relay       outbox → BullMQ
apps/reaper             stuck job recovery + reconciliation
libs/common             DTOs, enums, event contracts, zod schemas, queue names
libs/db                 Prisma schema, client, migrations
libs/credits            the ONLY code allowed to modify wallets/ledger
libs/queue              BullMQ factories, retry presets
libs/storage            S3 abstraction
libs/ai                 provider interfaces + mock/real implementations
libs/social             platform adapters
libs/observability      logger, metrics
packages/api-client      typed SDK generated from the API OpenAPI document (web + future mobile)
tests/{e2e,integration,chaos}
infra/{docker,grafana,prometheus,scripts}
```

Dependency rules:

- `apps/*` may import `libs/*`. `libs/*` must not import `apps/*`.
- `packages/api-client` is generated from the API OpenAPI document. Never hand-edit it; regenerate it instead.
- Apps must not import each other. Share code through `libs/common` or communicate via queues/events.
- Inside `apps/api`, modules interact through exported services or domain events, never by reaching into another module's repository.

---

## 4. Commands

```bash
pnpm install
docker compose up -d postgres redis minio mailhog     # infra only
pnpm db:migrate         # prisma migrate dev
pnpm db:seed
pnpm dev                # all apps via turbo
pnpm build
pnpm lint && pnpm typecheck
pnpm test               # unit
pnpm test:int           # integration (Testcontainers)
pnpm test:e2e           # Playwright against compose stack
pnpm test:chaos         # tests/chaos/run.sh
docker compose up --build   # full stack
```

---

## 5. Non-negotiable rules (credits and money)

These are the highest priority rules. Violating them is a bug even if tests pass.

1. **Only `libs/credits` may write to `wallets` or `credit_ledger`.** No other module runs SQL against them.
2. Reserve, capture, and refund are **single DB transactions** with guarded `UPDATE ... WHERE available >= :cost` style statements. Never read-then-write balances in application code.
3. Ledger is **append-only**. Never update or delete ledger rows (except in test teardown).
4. Every ledger insert carries `(reference_type, reference_id, entry_type)` with a **unique constraint** to guarantee idempotency.
5. Wallet columns have `CHECK (available >= 0 AND reserved >= 0)`.
6. **Signup bonus (50 credits)** is created in the same transaction as the user. The amount comes from `SIGNUP_BONUS_CREDITS` config, never hardcoded in logic.
7. **Costs come from the server** (`pricing_rules`), never from the client.
8. Refund only on system failure after retries are exhausted (or permanent error). Refund must be idempotent and must be a no-op after capture.
9. Any code path that creates a job must reserve credits and create the job and outbox event in **one transaction**.

---

## 6. Reliability rules

- **No direct queue pushes from request handlers** after a DB write. Use the **outbox** (`outbox_events`) and let `outbox-relay` publish.
- Every worker handler must be **idempotent**: running it twice yields the same result with no double charge, double file, or double post.
- Workers must: set a lease (`locked_until`), send heartbeats, save stage **checkpoints**, and handle `SIGTERM` gracefully.
- Use exponential backoff from `libs/queue` presets. Never write ad-hoc `setTimeout` retries.
- Publishing must check for an existing `external_post_id` / platform post before retrying.
- External calls (LLM, image, TTS, social APIs) need timeouts, retry policy, and error classification: `TRANSIENT` (retry) vs `PERMANENT` (fail + refund).
- Never hold a DB transaction open while calling an external API.
- Long work belongs in workers, never in API request handlers.

---

## 7. Coding standards

**TypeScript**

- `strict: true`. No `any` (use `unknown` + narrowing). No non-null assertions unless justified in a comment.
- Prefer small pure functions; keep side effects at the edges.
- Validate all external input (HTTP bodies, queue payloads, LLM output, webhooks) with **zod** or class-validator.
- Use enums/union types from `libs/common` for statuses and event types; no magic strings.
- Money/credits are **integers**. Never floats.
- Dates are UTC; store `timestamptz`.

**NestJS**

- One module per domain; controller (HTTP) → service (logic) → repository (DB).
- DTOs for every endpoint; Swagger decorators on all routes.
- Use guards for auth/RBAC; use interceptors for logging and idempotency; use a global exception filter returning `{ code, message, details }`.
- Config via `@nestjs/config` with a validated schema. Never read `process.env` directly outside the config module.

**Next.js**

- App Router, server components by default; client components only when needed.
- Data fetching with TanStack Query; typed API client generated from OpenAPI.
- Forms with react-hook-form + zod. Accessible components (labels, focus, keyboard).
- No secrets in client bundles; only `NEXT_PUBLIC_*` values.

**Database**

- All schema changes via Prisma migrations. Never edit the DB by hand.
- Add indexes with the query that needs them. Use `FOR UPDATE SKIP LOCKED` for queue-like table polling.
- Use raw SQL (`$executeRaw`) inside `$transaction` for credit-critical statements.

**Logging and errors**

- Use the shared pino logger with `requestId`, `userId`, `jobId`, `stage`. Never log secrets, tokens, or full prompts containing PII.
- Throw typed errors with stable `code` values. Don't swallow errors; log or rethrow with context.

---

## 8. AI provider rules

- All AI/social/storage integrations sit behind interfaces in `libs/ai`, `libs/social`, `libs/storage`.
- Every interface has a **Mock implementation** that is deterministic and fast. Local dev and CI use mocks by default (`AI_PROVIDER=mock`).
- LLM output must be requested as structured JSON and **validated with zod**; on validation failure retry once with a repair prompt, then fail as `PERMANENT`.
- Treat user/brand text as untrusted data in prompts (prompt-injection hygiene). Run moderation **before** reserving credits.
- Mock providers support failure injection via env: `FAIL_STAGE=IMAGE`, `FAIL_RATE=0.3`, `LATENCY_MS=2000`, used by chaos and e2e tests.

---

## 9. Testing requirements

Every change ships with tests. See `PROJECT.md` section 13 for the full matrix (C1-C12 credits, R1-R11 chaos, E2E journeys).

- **Unit:** pure logic, state machines, pricing, adapters.
- **Integration:** use Testcontainers (real Postgres and Redis). Never mock the database for credit logic.
- **Concurrency:** credit and publish races must have `Promise.all` tests.
- **Chaos:** worker kill, Redis/DB restart, SIGTERM, duplicate delivery.
- **E2E:** Playwright against the compose stack with mock providers.
- Coverage gates: `libs/credits` + state machines ≥ 95%, overall ≥ 80%.
- Tests must be deterministic: no real network, no reliance on wall-clock sleeps (use fake timers or polling helpers with timeouts).
- Do not delete or weaken a failing test to make CI pass. Fix the cause.

---

## 10. Security rules

- Hash passwords with argon2. JWT in httpOnly, SameSite cookies. CSRF protection for cookie auth.
- Every workspace-scoped query must filter by the caller's workspace membership (multi-tenant isolation). Add a test for each new endpoint.
- Encrypt social tokens at rest (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`). Never return tokens from the API.
- Validate upload MIME/size, use presigned URLs, block SSRF when fetching user-supplied URLs.
- Rate limit auth and generation endpoints.
- Never commit secrets. `.env` is git-ignored; keep `.env.example` current.

---

## 11. Definition of Done (per task)

- [ ] Matches `PROJECT.md` (or spec updated in same change)
- [ ] Types, lint, unit, integration tests pass locally
- [ ] New behavior has tests (including failure paths)
- [ ] Credit invariants preserved (rules in section 5)
- [ ] Idempotency and retry behavior considered
- [ ] Logs/metrics added for new flows
- [ ] OpenAPI/docs/README updated
- [ ] No secrets, no `console.log`, no commented-out code, no TODOs without an issue reference

---

## 12. Things agents must NOT do

- Do not add microservices, new databases, or new message brokers without approval.
- Do not bypass `libs/credits`, the outbox, or the lease/heartbeat mechanism "for simplicity".
- Do not call real AI/social APIs in tests.
- Do not change migration files that were already merged; add a new migration.
- Do not install heavy dependencies without justification; prefer what is in the stack.
- Do not hardcode prices, the 50-credit bonus, retry counts, or timeouts; use config / `pricing_rules`.
- Do not rewrite unrelated files or reformat the whole repo in a feature change.

---

## 13. When you finish a task, report

1. What changed (files, behavior).
2. How it was tested (commands and results).
3. Assumptions made.
4. Risks or follow-ups.
