# Phase progress

The authoritative version of this table lives in [`PROJECT.md` §12](./PROJECT.md#phase-progress).
This file exists so progress can be read without scrolling a thousand lines of
specification.

**Last updated:** after the browser journey went green and the Phase 10 security
pass started.

| #   | Phase                             | Status                                                       |
| --- | --------------------------------- | ------------------------------------------------------------ |
| 0   | Foundation                        | Shipped (`docker compose up` unverified — no Docker here)    |
| 1   | Auth, users, wallet, signup bonus | Shipped (same one gap)                                       |
| 2   | Credit engine                     | Shipped                                                      |
| 3   | Brands, campaigns, posts, assets  | Shipped                                                      |
| 4   | Job pipeline with mock AI         | Shipped                                                      |
| 5   | Reliability layer                 | **Partial** — R5 (a real SIGKILL) not implemented            |
| 6   | Real AI integration               | **Partial** — never run against a real provider key          |
| 7   | Scheduling and publishing         | Shipped (mocks only — no real adapter, no OAuth, no email)   |
| 8   | Frontend (Next.js)                | Shipped — 14/14 browser journeys pass locally                |
| 9   | Analytics, admin, observability   | **Partial** — analytics built; no Grafana panel has rendered |
| 10  | Hardening and launch polish       | **Partial** — security pass started                          |

**7 shipped · 4 partial · 0 untouched**

## What "partial" means here

Each partial phase is missing proof or work that needs infrastructure or
credentials this environment does not have.

- **Phase 5** needs Redis. `tests/chaos/run.sh` reproduces the exact database
  state a `kill -9` leaves behind — `PROCESSING`, an unrenewed lease, partial
  checkpoints — and asserts the real reaper makes the real decision. It reports
  R5 as `SKIP` and exits non-zero, because a chaos harness that reports green for
  what it did not do is worse than none.
- **Phase 6** needs a network. Every provider's request and response handling runs
  against a stub transport, and the renderer produces real mp4s with real ffmpeg.
  What has never happened is a call to a live provider API, so their rate limits,
  outages and pricing are unknown.
- **Phase 9** has its analytics worker, campaign analytics, admin console, Bull
  Board, queue-depth metric, alerts and dashboard. The Prometheus and Grafana
  containers have never started here, so no panel has rendered. The expressions
  are drift-tested; a chart on a screen is not.
- **Phase 10** has helmet, an explicit CORS allow-list, double-submit CSRF,
  encrypted social tokens, upload validation and presigned PUT. It still lacks a
  k6 load test, an index review, a backup/restore runbook, chaos R5, a CI
  dependency-audit job and the README chaos GIF.

None of these gaps are hidden by a green build. They are stated in `PROJECT.md`
beside the code they affect.

## Phase 8 is shipped

The screens, accessibility semantics and API integration are built. The browser
suite now runs against a live API and passed 14/14 locally across Chromium and a
Pixel 7 viewport: registration, the 50-credit badge, brand and campaign creation,
generation with live SSE progress, approval, account connection and scheduling.
The same suite runs in CI against the compose stack.

The jsdom component tests remain the fast feedback loop. The browser journey adds
what jsdom cannot: layout, real SSE, and real HTTP round trips.

## Phase 7 is shipped, but only against mocks

Phase 7 completes every part of its Definition of Done that can be proven without
a real social platform. What it does **not** have is a single byte leaving the
process:

- no real `linkedin` or `instagram` adapter behind `SocialAdapter` — only the
  deterministic mock, so the no-double-post guarantee has never been tested
  against a platform that could reject it;
- no OAuth authorization-code flow — `POST /social-accounts` accepts an
  already-obtained token;
- no email. The in-app half of "failure notifications (in-app + email)" exists;
  the mail half does not.

The interface is the seam the real adapters plug into, and the publisher depends
on the interface rather than on the mock. What that buys is a guarantee about our
own behaviour — a worker killed mid-publish does not double-post, an expired
token refreshes and succeeds — and it buys nothing about anyone else's.

## Running the gates

```bash
pnpm install
./scripts/pg-local.sh start            # no Docker in this environment
export DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow

pnpm lint && pnpm typecheck && pnpm build && pnpm format:check
pnpm test:coverage                     # unit
pnpm db:migrate && pnpm db:seed        # db:seed seeds pricing_rules; without it every generation 500s

TEST_DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow_test \
  npx jest --config jest.integration.config.js    # integration, real Postgres

./scripts/smoke-phase1.sh              # 11 assertions, real HTTP server
./scripts/smoke-phase4.sh              # 33 assertions, real HTTP server + SSE
CHAOS_DATABASE_URL=... ./tests/chaos/run.sh        # R1-R4; R5 SKIPs without Redis
```

Last full local gate: lint, typecheck, build and format clean; **994 unit**,
**482 integration**, **14/14 browser journeys**. The browser run used `pnpm dev`,
local Postgres/Redis and an S3-compatible test server because this environment has
no Docker daemon; CI runs the same suite against compose.

## Commit map

| Phase | Commits                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| 0–1   | foundation and auth, through `db-adopt-legacy` (Drizzle cutover)                |
| 2     | `feat(credits)` — reserve/capture/refund/adjust                                 |
| 3     | `feat(studio)` — workspaces, brands, campaigns, posts, assets                   |
| 4     | `364a115`, `e55034d`, `0d3ceeb` — stage machine, runner, relay + endpoints      |
| 5     | `28c0485` — lease, heartbeat, reaper, operator DLQ                              |
| 6     | `8c9dc97`, `07e01ce`, `35ddcda` — providers, renderer, moderation, brand memory |
| 7     | `8c9dc97`-era: publisher, scheduler, mock adapters                              |
| 8     | `18544a5`, `2b49265`, `9479c53`, `9087bcc` — frontend, api-client, e2e harness  |
| 9     | `feat(observability)` — collector, alert rules, dashboard, analytics, admin     |
