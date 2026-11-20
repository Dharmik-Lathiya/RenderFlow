# User Flow Tests — RenderFlow

> Evidence for the browser-journey part of the production-readiness audit.
> Last verified against the working tree containing the fixes in
> `MASTER_AUDIT.md` (post `c0d015f`), 2026-11-20.

## 1. What was actually run

The canonical journey is `tests/e2e/journey.spec.ts`, executed through
`./scripts/e2e.sh`. It runs in two Playwright projects (`chromium` desktop and
`mobile`), 14 tests total, against a real web server, API, Postgres, Redis,
outbox relay, and content/media workers.

Local harness used for both clean passes:

| Component      | Endpoint / command                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Postgres       | `127.0.0.1:5433`, disposable `renderflow_test` / `renderflow_chaos` databases                            |
| Redis          | `127.0.0.1:6379`, no persistence                                                                         |
| S3-compatible  | disposable local stub at `127.0.0.1:9000`, bucket `renderflow-assets` (Docker/MinIO is unavailable here) |
| API            | `node apps/api/dist/main.js`, `METRICS_PORT=4010`, `RATE_LIMIT_ENABLED=false`                            |
| Outbox relay   | `node apps/outbox-relay/dist/main.js`, `METRICS_PORT=4011`                                               |
| Content worker | `node apps/content-worker/dist/main.js`, `METRICS_PORT=4012`, mock AI                                    |
| Media worker   | `node apps/media-worker/dist/main.js`, `METRICS_PORT=4013`, mock AI                                      |
| Web            | built Next standalone server on `127.0.0.1:3000`, `API_INTERNAL_URL=http://127.0.0.1:4000/api/v1`        |

Two harness-only settings matter and must not be read as application guarantees:

1. Registration rate limiting is disabled so 14 fresh accounts can be created in
   one run. The production rate limit is exercised in `tests/integration/rate-limit.spec.ts`.
2. Pricing rules are seeded before the run. The integration suite truncates the
   shared test database, so a missing seed makes generation fail with
   `PRICING_UNAVAILABLE`. This happened once between verification attempts; after
   reseeding, the journey passed twice consecutively. The application behaved
   correctly by refusing an unpriced charge.

The first attempt used `next dev`; its HMR websocket handshake failed in this
environment (`net::ERR_INVALID_HTTP_RESPONSE`) and React never hydrated, so form
clicks produced native GETs. The browser run was therefore performed against the
built standalone server, which is closer to the deployed artifact. This is a
local tooling limitation, not an application defect, but it is recorded here so
nobody mistakes the dev-server failure for a green run.

## 2. Flow coverage matrix

| User flow                                                     | Browser journey | Lower-level evidence                                                                             | Status |
| ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ | ------ |
| Sign up, receive 50 credits, land on dashboard                | ✔               | `tests/integration/auth.spec.ts`, `signup-bonus.spec.ts`, `credits-internal.spec.ts`             | PASS   |
| Create workspace/brand, plan campaign, create caption post    | ✔               | `tests/integration/workspaces.spec.ts`, `studio.spec.ts`, `festival.spec.ts`                     | PASS   |
| Generate a caption with live progress, see credit reservation | ✔               | `jobs-api.spec.ts`, `job-runner.spec.ts`, `worker-handler.spec.ts`, `job-progress.spec.tsx`      | PASS   |
| Watch SSE progress and stop polling at terminal state         | ✔ (end-to-end)  | `apps/web/src/app/posts/[postId]/job-progress.spec.tsx` (4 lifecycle regressions)                | PASS   |
| Approve generated work                                        | ✔               | `tests/integration/studio.spec.ts`, `publishing-api.spec.ts`                                     | PASS   |
| Connect an account and schedule the post                      | ✔               | `tests/integration/publishing-api.spec.ts` (including `SCHEDULED` status and cancel regressions) | PASS   |
| Verify the credit ledger pages correctly                      | —               | `tests/integration/auth.spec.ts` page-2 regression                                               | PASS   |
| Sign out from both shell controls                             | ✔               | `apps/web/src/components/shell.spec.tsx`                                                         | PASS   |
| 402 responses are not retried by TanStack Query               | —               | `apps/web/src/lib/providers.spec.tsx`                                                            | PASS   |
| Relative same-origin API base works in the browser            | ✔ (implicit)    | `packages/api-client/src/client.spec.ts`                                                         | PASS   |
| Keyboard-only operation                                       | ✔               | component accessibility tests under `apps/web/src`                                               | PASS   |
| Every form control has an accessible label                    | ✔               | component accessibility tests under `apps/web/src`                                               | PASS   |
| Credit balance announced, not only drawn                      | ✔               | `components/ui` live-region tests                                                                | PASS   |
| Navigation and layout at phone width                          | ✔               | responsive assertions in `journey.spec.ts`                                                       | PASS   |

## 3. Results

| Run    | Command                                               | Result                     |
| ------ | ----------------------------------------------------- | -------------------------- |
| Pass 1 | `E2E_BASE_URL=http://127.0.0.1:3000 ./scripts/e2e.sh` | **14/14 passed** (25–28 s) |
| Pass 2 | same command, after reseeding the disposable DB       | **14/14 passed** (25 s)    |
| Repeat | same command, no code changes                         | **14/14 passed** (24 s)    |

All assertions are on user-visible state. No test stubs the API client or asserts
on a request count in place of a visible outcome.

## 4. Flows not covered by E2E

- Real OAuth authorization-code exchange, token refresh, or real social publish.
  `POST /social-accounts` in the browser journey connects a mock account.
- Real AI, S3, SMTP/Resend, Instagram Graph, or billing calls. Mock providers and
  the local S3 stub are used; see `PRODUCTION_READINESS.md`.
- Full Docker Compose boot and image builds (no Docker daemon locally).
- Load/soak tests: queue drain under backlog and same-minute publish bursts are
  documented but not implemented (see `PERFORMANCE_AUDIT.md`).

These are explicit gaps, not implied passes.
