# Final Production Report — RenderFlow

**Date:** 2026-11-20
**Decision:** **NOT PRODUCTION READY**

## 1. Scope

This report closes the audit loop started at `3334958`. It covers repository and
architecture mapping, feature/user-flow inventory, frontend/API/DB inspection,
security and performance review, targeted fixes with regression tests, and two
consecutive full local verification passes. Source of truth remains `PROJECT.md`;
every divergence found is registered in `MASTER_AUDIT.md`.

## 2. What changed

### Application and library fixes

- `packages/api-client/src/client.ts`: accept same-origin relative API bases by
  parsing them against a dummy origin and returning path+query. This fixes the
  live "Could not reach the server" failure where `new URL('/api/v1/...')`
  threw before `fetch()`. Already pushed as `c0d015f`.
- `apps/web/src/app/posts/[postId]/job-progress.tsx`: stop SSE and fallback
  polling on terminal jobs and unmount; validate SSE/poll frames with `jobSchema`;
  treat `CANCELLED` as terminal.
- `apps/api/src/publishing/publishing.service.ts`: write `posts.status=SCHEDULED`
  in the same transaction as publish jobs, accept idempotent replay, and restore
  `APPROVED` on full cancellation.
- `apps/api/src/credits/credits.service.ts` and `libs/credits/src/signup-bonus.ts`:
  pass the page offset into the ledger query.
- `apps/web/src/components/shell.tsx`: handle logout rejection on both sign-out
  controls.
- `apps/web/src/lib/providers.tsx`: do not retry 402 responses.
- `libs/common/src/config/provider-mode.ts`, `libs/ai/src/factory.ts`,
  `libs/social/src/runtime.ts`, `apps/{publisher,analytics}-worker/src/main.ts`:
  fail at boot if a mock provider is configured in production; refuse `real`
  social publishing until a real adapter exists.
- Removed stray empty file `libs/queue/_tmp_8720_2b9325f8`.

### Tests added

- API client relative URL regression test (in the pushed commit).
- SSE/polling lifecycle, terminal status, unmount cleanup, and malformed frame tests.
- Scheduling status and cancellation restore integration tests.
- Credit ledger page-2 integration test.
- Sign-out rejection and 402 retry component tests.
- Provider-mode guard tests in `libs/common`, `libs/ai`, and `libs/social`.

### Documentation

Created and updated `docs/engineering-audit/{REPOSITORY_MAP,ARCHITECTURE_REVIEW,
MASTER_AUDIT,FEATURE_INVENTORY,USER_FLOW_TESTS,SECURITY_AUDIT,PERFORMANCE_AUDIT,
PRODUCTION_READINESS,KNOWN_LIMITATIONS,FINAL_PRODUCTION_REPORT}.md`, plus
corrections to `PROJECT.md` and `.env.example`.

## 3. Verification evidence

Two consecutive full passes were executed against the same working tree.

| Gate                              | Pass 1                 | Pass 2                 |
| --------------------------------- | ---------------------- | ---------------------- |
| `pnpm lint`                       | PASS                   | PASS                   |
| `pnpm typecheck`                  | 33/33                  | 33/33                  |
| `pnpm test`                       | 96 suites / 1197 tests | 96 suites / 1197 tests |
| `pnpm build`                      | 20/20                  | 20/20                  |
| Integration Jest (real Postgres)  | 31 suites / 533 tests  | 31 suites / 533 tests  |
| `./tests/chaos/run.sh`            | 40/40, 0 skip          | 40/40, 0 skip          |
| `E2E_BASE_URL=… ./scripts/e2e.sh` | 14/14                  | 14/14                  |

The E2E run used local Postgres, Redis, a disposable S3-compatible stub, mock
providers, the built standalone web server, and registration rate limiting
disabled. One intermediate E2E attempt failed because the integration suite had
truncated `pricing_rules` in the shared disposable database; after reseeding,
E2E passed and was repeated green. No application code was changed for that
result. See `USER_FLOW_TESTS.md` for the full harness description.

## 4. Assumptions

- Mock providers remain correct for local development and CI; production must
  configure real providers or fail at boot.
- The local S3 stub is acceptable only for exercising browser journeys; it is
  not evidence of real S3/MinIO readiness.
- `SCHEDULED` is a committed state that blocks edits; full cancellation returns
  the post to `APPROVED`.
- Coverage numbers reported are the executed suite counts, not proof that the
  documented per-path coverage gates are enforced (AUD-06).

## 5. Why this is not production ready

Production readiness is blocked by factors the local test matrix cannot fix:

1. No real social publish adapter and no OAuth authorization-code flow.
2. No real AI, email, S3, or billing verification with credentials.
3. Open P1 defects: heartbeat loss propagation (AUD-09), OWNER self-approval
   (AUD-22), content→media handoff (AUD-23), publisher lease ownership
   (AUD-24), and outbox/refund message semantics (AUD-28/AUD-29).
4. Live Vercel deployment serves the fixed client bundle but still returns 404
   for `/api/v1/health/live`; the API host is not configured for the web rewrite.
5. Docker Compose, image builds, Grafana rendering, alert delivery, load/soak
   tests, and the documented coverage gates were not verified/enforced.

See `PRODUCTION_READINESS.md` and `KNOWN_LIMITATIONS.md` for the complete list
and the ordered remediation plan.

## 6. Risks and follow-ups

The safest deployment posture today is to keep production mock providers
disabled, which means the publisher will refuse to start. This is intentional:
the previous behavior could mark posts published without posting them. The next
engineering milestone should be real publish adapters plus OAuth, followed by
AUD-09/22/23/24/28/29 and real provider verification. After those land, re-run
the same matrix and require external evidence before changing the decision.
