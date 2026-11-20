# Architecture Review — RenderFlow

> Phase 0 discovery document. Based on direct inspection of source, migrations,
> compose/CI configuration and the existing design docs. No application logic was
> changed during discovery. Findings that need code changes are tracked in
> `MASTER_AUDIT.md`.

## 1. Assessment against the expected architecture

| Expected                                                                    | Actual                                                                                                                                                                                                                               | Verdict                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Next.js App Router + TS + Tailwind + shadcn-style UI + TanStack Query + SSE | `apps/web` is Next 16.4.3 App Router, Tailwind tokens in `globals.css`, local accessible UI primitives in `src/components/ui.tsx`, TanStack Query in `src/lib/providers.tsx`, SSE job progress in `posts/[postId]/job-progress.tsx`. | **Matches** (UI primitives are local, not the shadcn CLI; functionally equivalent). |
| NestJS modular monolith, `/api/v1`, Swagger                                 | `apps/api/src/main.ts` + 14 modules, global prefix, `/docs-json`, generated client contract.                                                                                                                                         | **Matches**.                                                                        |
| PostgreSQL + Drizzle + transactions + migrations                            | 16 Drizzle migrations, schema-declared constraints, raw SQL credits.                                                                                                                                                                 | **Matches**.                                                                        |
| Redis + BullMQ + outbox + retry/backoff                                     | 6 queues, `libs/outbox` relay with `FOR UPDATE SKIP LOCKED`, presets.                                                                                                                                                                | **Matches**.                                                                        |
| 6 workers                                                                   | All six apps exist with separate entry points.                                                                                                                                                                                       | **Matches**.                                                                        |
| S3/MinIO, mock/real AI, social adapters                                     | Storage and AI provider seams exist; `libs/social` has **only a mock publish adapter**.                                                                                                                                              | **Partial** — see §5.                                                               |
| Monorepo pnpm/Turbo + typed client                                          | 21 workspaces, generated route map, drift test.                                                                                                                                                                                      | **Matches**.                                                                        |

Overall: the intended architecture is genuinely implemented, not just documented.
The weak points are at the **external integration boundary** and in a few
production-facing configuration defaults — not in the core credit/job machinery.

## 2. Credit engine (highest-value subsystem)

Files: `libs/credits/src/{reserve,balance,purchase,pricing,signup-bonus}.ts`.
No code outside `libs/credits` writes to `wallets` or `credit_ledger`
(verified by repository-wide search; the only other SQL touching those tables is
in test fixtures/teardown).

Strengths confirmed by reading source and by the integration suite:

- Reserve/capture/refund/adjust are single transactions with guarded UPDATEs.
- Idempotency is enforced twice: a guarded job-state claim plus the unique
  `(reference_type, reference_id, entry_type)` ledger index; a CHECK constraint
  forbids a job being both captured and refunded.
- `reserveOnce()` re-reads the idempotency key outside an aborted transaction so a
  retried HTTP request does not receive a false `402`.
- Missing pricing throws `PRICING_UNAVAILABLE`; no silent zero/default charge.
- Reconciliation is **per bucket** and intentionally does not use
  `SUM(amount)` over the whole ledger; the sign convention is documented and
  tested against an independently written SQL formulation (C12).
- Signup bonus and personal workspace are created with the user in one transaction.

Evidence: `tests/integration/credit-engine.spec.ts` (C1–C12, including 100 parallel
reserves), `signup-bonus.spec.ts`, `purchase.spec.ts`. All passed locally
(533/533 integration tests after the audit regressions were added).

Risk: the credit engine is correct **only if callers use it**. The API's generation
paths do; any future direct SQL would bypass the guarantees. Keep the
repository-wide grep as a CI assertion.

## 3. Job pipeline and reliability

- Stage machine: `libs/jobs/src/stage-machine.ts`; PLAN→SCRIPT→IMAGE→VOICE→RENDER,
  festival variants reuse it.
- Runner: `libs/jobs/src/runner.ts` writes checkpoint, stage pointer and
  `job.stage_completed` outbox event in one transaction; capture happens only when
  all stages complete.
- Worker handler: `libs/jobs/src/worker-handler.ts` takes a **durable** attempt
  counter lease (`libs/jobs/src/lease.ts`) before work; heartbeats are guarded on
  `worker_id`; `validateLeaseConfig` refuses to boot if heartbeat ≥ lease/2.
- Reaper: `libs/jobs/src/reaper.ts`, leader-locked with a Postgres advisory lock,
  requeues with the **original** `job.created` payload (a previous version emitted a
  payload workers rejected — now regression-tested).
- Outbox relay: at-least-once by design; dedupe comes from deterministic BullMQ job
  ids, not from holding a DB transaction open across Redis.
- Graceful shutdown: `libs/common/src/lifecycle/graceful-shutdown.ts`, drains
  registered per worker.

Evidence: 40/40 chaos assertions locally, including a real `SIGKILL` inside SCRIPT
(R5) with lease expiry, reaper requeue and checkpoint resume in a second process;
integration suites `job-runner`, `worker-handler`, `reliability`, `outbox-relay`,
`publish-replay`.

Known gap: queuedrain and same-minute publish load tests are not implemented;
k6 is manual. No claim about throughput under load is made here.

## 4. Tenancy / authorization

- `WorkspaceAccessService.scope()` is the single choke point for workspace-scoped
  queries. It deliberately returns the same error for "missing" and "forbidden" so
  ids cannot be probed.
- Capabilities are a table (`roleHas`), not a rank: `EDITOR` and `APPROVER` have
  disjoint `write`/`approve` rights below `OWNER`; editors cannot approve their own
  content. Verified by unit tests and integration suites (`workspaces`, `studio`,
  `admin`).
- Rate-limit guard runs before CSRF/auth so expensive argon2 work is not reached by
  refused requests; user-scoped limits run in a second guard after auth.
- Refresh sessions are family/hash based (migration 0015) and a password reset
  revokes all sessions.

Residual risk: every **new** workspace-scoped endpoint must call `scope()`; there is
no architectural enforcement beyond review and tests. The feature audit must
check each endpoint.

## 5. External integrations — the main production gap

| Concern            | Status                                                                                                                                                                                               | Production impact                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Text/image/TTS AI  | Real OpenAI/Anthropic/Replicate/ElevenLabs providers exist behind interfaces with timeouts, classification, repair-once structured output and fallback. Never called with a real key here.           | Configurable; request/response handling tested with stub transports.                                         |
| FFmpeg render      | Real, exercised end to end locally (real mp4, real fonts).                                                                                                                                           | Verified.                                                                                                    |
| Social **publish** | `apps/publisher-worker/src/main.ts` now validates `SOCIAL_PROVIDER` at boot and calls `adapterFor(...)`; `libs/social/src/runtime.ts:adapterFor()` throws for `real` because no real adapter exists. | **No real publishing exists.** Production boot now fails instead of marking posts PUBLISHED without posting. |
| Social **metrics** | Instagram Graph adapter only in analytics worker; LinkedIn reports "unsupported" (not zero).                                                                                                         | Honest, but unverified against real tokens.                                                                  |
| OAuth              | `POST /social-accounts` accepts an already-obtained token. No authorization-code flow.                                                                                                               | **BLOCKED** without platform app credentials.                                                                |
| Email              | Resend + SMTP/SMTP-to-MailHog transports, unit-tested with fakes; refused in production for `log`/`mailhog`.                                                                                         | Delivery unverified.                                                                                         |
| Billing            | Stub top-up refused in production; no real provider.                                                                                                                                                 | Documented non-goal for v1.                                                                                  |

**Critical configuration finding — MITIGATED:** the original audit found no
worker refusing mock providers in production. That is fixed: `createProviders()`
refuses mock text/image/TTS modes, the analytics worker refuses mock social
metrics, and the publisher refuses both mock and `real` publish modes until a real
adapter exists. The remaining blocking gap is the missing real publish adapter
itself, not silent misconfiguration. See AUD-01–AUD-03.

## 6. Observability / operations

- pino with redaction; Prometheus with `renderflow_` prefix on every series;
  14 derived gauges; `/health/live` and `/health/ready` (real DB/Redis/S3 probes,
  503 on degradation); per-worker `/metrics`.
- 11 alert rules with `for:` clauses and a 12-panel provisioned Grafana dashboard;
  drift-tested names/expressions.
- Backup/restore runbook + automated restore drill (md5 per table), scheduled backup
  script, index review pinned by a test.
- No Grafana panel has rendered here (no Docker daemon). Delivery of alerts to a
  real receiver depends on `SLACK_WEBHOOK_URL`. Both are BLOCKED locally.

## 7. Deployment topology

- `docker-compose.yml`: infra + all apps, digest-pinned images, health checks,
  `minio-init` gate, only API/web ports published. Observability is `profiles: [observability]`.
- Node apps share `infra/docker/node-app.Dockerfile` (multi-stage, `pnpm deploy --prod`,
  ffmpeg + fonts, non-root). Web uses a Next standalone image.
- CI covers image builds and an E2E compose boot; locally the Docker daemon is
  unavailable, so compose/image verification is **BLOCKED** and delegated to CI.
- Vercel serves **only** `apps/web` (marketing site today); API/workers run as
  containers. `rootDirectory` must be set in the Vercel dashboard (documented
  limitation).

## 8. Phase status reconciliation

`PROJECT.md` reports 9/12 phases shipped, 3 partial (6, 9, 10). That matches the
code: the partial labels are all about **unverified external infrastructure**, not
about missing in-process features, with one exception — real social **publishing**
is not implemented at all, even though Phase 7 is counted as shipped "against the
mock". This audit treats that as a production-blocking gap, not a semantic quibble.
