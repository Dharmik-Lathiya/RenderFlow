# Production Readiness — RenderFlow

> Final gate assessment, 2026-11-20.
> **Decision: NOT PRODUCTION READY**

## 1. Decision

RenderFlow is **NOT PRODUCTION READY**.

The application's in-process machinery is in good shape: the full local
verification matrix passed twice consecutively, including browser journeys and
chaos recovery. However, production readiness is blocked by missing real
publishing, unverified external providers, open P1 security/reliability defects,
and an incompletely configured live deployment. Shipping now would either fail
closed at boot (after the new guards) or, if those guards were bypassed, claim
work that did not happen.

## 2. Gate matrix

| Gate                                   | Status   | Evidence / blocker                                                                                                                  |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Build                                  | PASS     | `pnpm build` 20/20 on both passes                                                                                                   |
| Lint / typecheck                       | PASS     | lint clean; typecheck 33/33 on both passes                                                                                          |
| Unit tests                             | PASS     | 96 suites / 1197 tests on both passes                                                                                               |
| Integration (real Postgres)            | PASS     | 31 suites / 533 tests on both passes                                                                                                |
| Chaos R1–R5                            | PASS     | 40/40, 0 skip on both passes; real SIGKILL recovery                                                                                 |
| Browser journeys                       | PASS     | 14/14 in chromium + mobile on both clean passes; see `USER_FLOW_TESTS.md`                                                           |
| Credit invariants C1–C12               | PASS     | unit + integration + chaos; one charge, idempotent refund, no ledger drift                                                          |
| Tenancy / RBAC                         | PARTIAL  | Scoped services and tests exist; OWNER self-approval remains open (AUD-22)                                                          |
| Provider fail-fast                     | PASS     | Mock AI/social refused in production; real publish still unavailable (AUD-01–AUD-03)                                                |
| Real AI provider verification          | BLOCKED  | No credentials                                                                                                                      |
| Real social OAuth/publish              | BLOCKED  | No authorization-code flow and no real publish adapter                                                                              |
| Real email / S3 / billing verification | BLOCKED  | No credentials                                                                                                                      |
| Docker compose / image builds          | BLOCKED  | No Docker daemon locally; CI exists but results were not part of this audit                                                         |
| Observability                          | PARTIAL  | Metrics/alerts/Grafana config and drift tests exist; panel render, alert delivery, Redis exporter, and port layout unverified/fixed |
| Load / soak                            | NOT DONE | k6 script exists; no measured p95, queue drain, or burst result                                                                     |
| Coverage gates                         | FAIL     | Spec asks 95% credits/state machines and 80% overall; enforced config is lower/excludes critical paths (AUD-06)                     |
| Live web deployment                    | PARTIAL  | Login fix deployed, but `/api/v1/health/live` returns 404 — no API host configured                                                  |

## 3. Blocking work, in order

1. **Configure the live API path.** Set `API_INTERNAL_URL` (or a public
   `NEXT_PUBLIC_API_URL`) on the Vercel web project and
   `CORS_ORIGINS=https://renderflowapp.vercel.app` on the API. Verify
   `GET /api/v1/health/ready` through the web origin before retesting sign-in.
2. **Implement real social publishing** behind `libs/social`, plus the OAuth
   authorization-code flow and token refresh. Remove the boot guard only after a
   real adapter can actually publish.
3. **Fix P1 correctness defects:** AUD-09 (heartbeat loss), AUD-22
   (self-approval), AUD-23 (content→media handoff), AUD-24 (publisher lease
   ownership), AUD-28/AUD-29 (outbox/refund message semantics).
4. **Verify external providers** with real credentials: AI text/image/TTS, S3,
   SMTP/Resend, Instagram Graph, and billing or a documented billing non-goal.
5. **Run the infrastructure gates:** Docker Compose boot, image builds, MinIO
   bucket init, Prometheus/Grafana panel render, alert delivery, and a real
   backup/restore drill against the chosen production storage.
6. **Run load/soak tests** and publish actual p95 latency and queue-recovery
   numbers.
7. **Enforce the documented coverage gates** (AUD-06) or amend the spec and
   acceptance criteria.
8. **Re-run the full verification matrix:** lint/typecheck/unit, build,
   integration, chaos, E2E, then the external checks above. Two consecutive clean
   local passes are necessary but not sufficient for a production claim.

## 4. What was fixed in this audit

- Production fail-fast guards for mock AI/social/analytics providers.
- Live login relative-URL crash (`c0d015f`, already pushed).
- SSE/fallback-poll lifecycle, terminal status handling, and zod validation.
- Scheduled-post status transitions and cancellation restore.
- Credit ledger pagination offset.
- Sign-out rejection handling and 402 retry policy.
- Stale audit docs, stray temp file, and migration-name documentation.
- Regression tests for every local fix above.

## 5. Non-blocking follow-ups

- Jest open handles (AUD-08/AUD-40).
- Config-boundary cleanup (AUD-11/AUD-26) and unused `JWT_REFRESH_SECRET`
  (AUD-14/AUD-27).
- `brands.colors` migration (AUD-12), scoped settlement helper (AUD-13).
- Pre-deploy script, Redis exporter, `METRICS_PORT`, and shutdown drain order
  (AUD-35–AUD-38).
- UI state handling for regenerated job ids, `done` reconciliation, Generate
  idempotency key, and upload/poll aborts (AUD-30–AUD-33).

None of these changes the decision on its own, but they should be scheduled
before a later readiness review.
