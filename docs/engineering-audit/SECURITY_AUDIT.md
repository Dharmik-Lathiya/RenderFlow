# Security Audit — RenderFlow

> Read-only verification against the current working tree, 2026-11-20.
> Statuses use **FIXED**, **OPEN**, **MITIGATED**, or **BLOCKED** and map to the
> issue IDs in `MASTER_AUDIT.md`.

## 1. Summary

| Area                            | Status           | Notes                                                                                          |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Password hashing / auth cookies | PASS             | argon2, httpOnly SameSite cookies, CSRF header on writes; covered by `auth.spec.ts`            |
| Workspace tenancy               | PASS with caveat | `WorkspaceAccessService.scope()` is the choke point; every **new** endpoint still needs review |
| Credit mutation boundary        | PASS             | Only `libs/credits` writes wallets/ledger; constraints and guarded transactions tested         |
| Provider mode safety            | MITIGATED        | Mock AI/social in production now fails at boot; real social publishing still absent            |
| Social token encryption at rest | PASS             | AES-256-GCM; tokens omitted from API responses                                                 |
| OAuth / real platform publish   | BLOCKED          | No authorization-code flow, no real publish adapter; needs platform credentials                |
| Approval separation             | OPEN             | Role-gated, but OWNER can create and approve the same post; no `posts.created_by`              |
| Publisher lease ownership       | OPEN             | Post-claim writes are not all guarded by `worker_id`                                           |
| Public logout rate limiting     | OPEN             | `@Public()`, state-changing, no `@RateLimit` or config rule                                    |
| Config boundary                 | OPEN             | Several direct `process.env` reads remain outside validated config                             |
| Required-but-unused JWT secret  | OPEN             | `JWT_REFRESH_SECRET` is validated but refresh tokens are opaque hashes                         |
| Coverage gates                  | OPEN             | Documented 95% credits/state-machine gate is not enforced                                      |

**Production decision impact:** the open P1 items (approval self-review,
publisher lease ownership, missing real publish path) keep the system
**NOT PRODUCTION READY** even though the locally runnable tests pass.

## 2. Findings and evidence

### FIXED — mock providers in production (AUD-01, AUD-02, AUD-03)

`libs/ai/src/factory.ts` now refuses mock text/image/TTS modes when
`NODE_ENV=production`; `apps/analytics-worker/src/main.ts` refuses mock social
metrics; `apps/publisher-worker/src/main.ts` refuses both mock and `real` social
publish modes until a real adapter exists. Regression tests:
`libs/ai/src/factory.spec.ts`, `libs/common/src/config/provider-mode.spec.ts`,
`libs/social/src/provider-guard.spec.ts`.

The publisher guard is a mitigation, not an implementation: a production
deployment fails fast rather than falsely reporting publication.

### OPEN (P1) — self-approval by OWNER

- `libs/db/src/schema.ts:951-953` records `campaigns.createdBy`; `posts` has no
  creator column (`libs/db/src/schema.ts:988-1011`) but does have `approvedBy`.
- `apps/api/src/workspaces/studio.service.ts:436-453` creates a post without a
  creator, and `approvePost` only checks the `APPROVER` capability
  (`studio.service.ts:506-541`).
- `apps/api/src/workspaces/workspaces.service.ts:75-82,96-111` gives OWNER both
  write and approve capabilities.

An OWNER can author and approve the same post, and authorship is not auditable.
Fix: add `posts.created_by` in a **new** migration with backfill, set it on
create, and reject `approver === creator` unless a product-approved override is
explicitly accepted.

### OPEN (P1) — publisher lease ownership

The claim is correctly guarded with `SELECT ... FOR UPDATE SKIP LOCKED` and
lease/status predicates (`libs/social/src/publisher.ts:112-157`). Subsequent
writes are not: release (`libs/social/src/processor.ts:200-215`, line 214),
reclaim (`:489-502`, line 495), heartbeat (`:521-541`, line 530), failure update
(`libs/social/src/publisher.ts:275-286`, line 286), and `markPublished`
(`:307-326`, line 325) all filter by job ID only. A stale worker can therefore
extend or clear another worker's lease and overwrite terminal status. Generation
leases show the required pattern at `libs/jobs/src/lease.ts:188-196`.

Fix: thread `workerId` into every post-claim write and guard on
`status='PUBLISHING' AND worker_id=…`; stop the heartbeat on zero affected rows.

### PASS — social token encryption

AES-256-GCM is implemented in `libs/social/src/tokens.ts:32-124`, keys are
validated, tokens are encrypted before insert/upsert
(`apps/api/src/publishing/social-accounts.service.ts:93-151`), stored in
`socialAccounts.token` (`libs/db/src/schema.ts:496-520`), and excluded from API
views (`social-accounts.service.ts:37-53,245-257`;
`publishing.controller.ts:109-129`).

### BLOCKED — real OAuth and publish

`connectAccountSchema` requires a caller-supplied `accessToken`
(`apps/api/src/publishing/social-accounts.service.ts:24-35`) and the controller
accepts it directly (`publishing.controller.ts:109-113`). There is no
authorization-code exchange. Combined with the missing real publish adapter,
real platform publishing cannot be verified without credentials and adapter work.

### OPEN (P2) — public logout is unthrottled

`POST /auth/logout` is `@Public()` with no `@RateLimit`
(`apps/api/src/auth/auth.controller.ts:117-128`), unlike neighbouring public
auth routes (`:65,85-90,107,178,195,206`). No logout rule exists in
`apps/api/src/ratelimit/rate-limit.config.ts:12-50,76-92`. Impact is bounded to
the presented refresh token (`auth.service.ts:320-331`), but it contradicts the
controller's stated rule (`auth.controller.ts:42-46`).

Fix: add `RATE_LIMIT_LOGOUT_IP` to validated config and apply
`@RateLimit({ scope: 'ip' })`.

### OPEN (P2) — config boundary leaks

Direct reads remain at `apps/api/src/admin/admin.controller.ts:119`,
`apps/api/src/auth/auth.controller.ts:277,311`,
`apps/api/src/jobs/moderation.service.ts:65`, and
`apps/api/src/metrics/bull-board.ts:177`; workers also use local helpers
(`apps/content-worker/src/main.ts:48-50,77,88-90`). `OUTBOX_MAX_ATTEMPTS` is read
directly and is absent from `apps/api/src/config/env.ts`. Fix by adding keys to
validated zod schemas and injecting typed values.

### OPEN (P3) — legacy `JWT_REFRESH_SECRET`

Validated at `apps/api/src/auth/auth.config.ts:20-22,57-64` and
`apps/api/src/config/env.ts:30`, but access tokens use only
`JWT_ACCESS_SECRET` (`auth.service.ts:550-555`; `auth.guard.ts:83`) and refresh
tokens are opaque SHA-256 hashes (`password.ts:130-144`;
`auth.service.ts:557-569`). `OPERATIONS.md:354` already notes rotation has no
effect. Remove the requirement or implement signed refresh tokens consistently.

### FIXED / accepted — migration journal gap `0002`

The jump from `idx: 1` to `idx: 3` in `libs/db/drizzle/meta/_journal.json` is
intentional; the no-op guard documents it at
`scripts/fix-migration-journal.mjs:35-40`. No `0002*` migration was ever
generated. Stale wording in `PROJECT.md` was corrected in this audit.

### OPEN (P2) — coverage gates not enforced

Spec (`PROJECT.md:1591-1594`) requires ≥95% for credits/state machines and ≥80%
overall. `jest.config.js:169-178` enforces only global 80% and excludes
credit-critical files (`:111-128`) plus runner/lease/reaper (`:93,99-100`).
`jest.integration.config.js:143-168` sets a lower floor (70% global; 75% lines
for credits). CI runs both commands but produces no merged report that enforces
the documented gates. Either merge LCOV data and enforce per-path gates or amend
the spec.

### OPEN (P3, latent) — unscoped settlement helper

`JobsService.isSettled(jobId)` queries only by job ID
(`apps/api/src/jobs/jobs.service.ts:155-164`). The SSE caller authorizes first
(`jobs.controller.ts:87,112-123`), so no exploit exists today, but the helper is
unsafe to reuse. Push workspace/user scope into the query itself.

## 3. Verification performed

- `pnpm lint`, `pnpm typecheck`, `pnpm test`: PASS (96 suites / 1197 tests).
- Integration against real Postgres: PASS (31 suites / 533 tests), including
  workspace isolation, auth, CSRF, credits, and publishing suites.
- Chaos R1–R5: PASS (40/40), including real SIGKILL recovery and single-capture
  invariants.
- Browser journey: PASS (14/14) in two Playwright projects.

No live social, AI, email, billing, or S3 credentials were available; absence of
a failure here is not evidence those integrations are secure in production.
