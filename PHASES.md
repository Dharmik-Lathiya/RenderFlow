# Phase progress

The authoritative version of this table lives in [`PROJECT.md` §12](./PROJECT.md#phase-progress).
This file exists so progress can be read without scrolling a thousand lines of
specification.

**Last updated:** after Phase 7.

| #   | Phase                             | Status                                                     |
| --- | --------------------------------- | ---------------------------------------------------------- |
| 0   | Foundation                        | Shipped (`docker compose up` unverified — no Docker here)  |
| 1   | Auth, users, wallet, signup bonus | Shipped (same one gap)                                     |
| 2   | Credit engine                     | Shipped                                                    |
| 3   | Brands, campaigns, posts, assets  | Shipped                                                    |
| 4   | Job pipeline with mock AI         | Shipped                                                    |
| 5   | Reliability layer                 | **Partial** — R5 (a real SIGKILL) not implemented          |
| 6   | Real AI integration               | **Partial** — never run against a real provider key        |
| 7   | Scheduling and publishing         | Shipped (mocks only — no real adapter, no OAuth, no email) |
| 8   | Frontend (Next.js)                | Not started                                                |
| 9   | Analytics, admin, observability   | Partially started — the admin API only                     |
| 10  | Hardening and launch polish       | Not started                                                |

**7 shipped · 2 partial · 1 partially started · 2 untouched**

## What "partial" means here

Both partial phases are missing the same kind of thing: the part that can only be
proven against infrastructure this environment does not have.

- **Phase 5** needs Redis. `tests/chaos/run.sh` reproduces the exact database
  state a `kill -9` leaves behind — `PROCESSING`, an unrenewed lease, partial
  checkpoints — and asserts the real reaper makes the real decision. It reports
  R5 as `SKIP` and exits non-zero, because a chaos harness that reports green for
  what it did not do is worse than none.
- **Phase 6** needs a network. Every provider's request and response handling runs
  against a stub transport, and the renderer produces real mp4s with real ffmpeg.
  What has never happened is a call to a live provider API, so their rate limits,
  outages and pricing are unknown.

Neither gap is hidden by a green build. Both are stated in `PROJECT.md` beside the
code they affect.

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

Current state: **720 unit**, **353 integration**, smoke-phase1 11/11,
smoke-phase4 33/33, chaos R1–R4 14/14.

## Commit map

| Phase | Commits                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| 0–1   | foundation and auth, through `db-adopt-legacy` (Drizzle cutover)                |
| 2     | `feat(credits)` — reserve/capture/refund/adjust                                 |
| 3     | `feat(studio)` — workspaces, brands, campaigns, posts, assets                   |
| 4     | `364a115`, `e55034d`, `0d3ceeb` — stage machine, runner, relay + endpoints      |
| 5     | `28c0485` — lease, heartbeat, reaper, operator DLQ                              |
| 6     | `8c9dc97`, `07e01ce`, `35ddcda` — providers, renderer, moderation, brand memory |
