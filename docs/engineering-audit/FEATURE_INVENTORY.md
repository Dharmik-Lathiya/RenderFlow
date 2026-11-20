# Feature Inventory

Audited at commit `3334958`. This inventory is derived from the actual Nest controllers, worker entrypoints, web routes, and the passing baseline verification suite. "Implemented" means code and tests exist; it does not imply that every external provider has been verified with live credentials.

API routes below include the global prefix `/api/v1` unless marked unversioned.

## 1. Platform capabilities

| Capability           | Implementation             | Status                                 | Evidence / notes                                                                           |
| -------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Modular monolith API | `apps/api`, domain modules | Implemented                            | 21 workspaces, `pnpm build` passes                                                         |
| Content workers      | `apps/content-worker`      | Implemented                            | Caption/hashtag/plan/script stages with checkpoints                                        |
| Media workers        | `apps/media-worker`        | Implemented                            | Image, TTS, and FFmpeg reel stages                                                         |
| Publisher worker     | `apps/publisher-worker`    | Implemented with mock-only social path | Real publish adapters are not implemented; see AUD-02                                      |
| Analytics worker     | `apps/analytics-worker`    | Implemented                            | Metrics sync with real Instagram adapter and deterministic mock; live verification blocked |
| Outbox relay         | `apps/outbox-relay`        | Implemented                            | Transactional outbox → BullMQ                                                              |
| Reaper               | `apps/reaper`              | Implemented                            | Stuck job recovery and reconciliation                                                      |
| Credit ledger/wallet | `libs/credits`             | Implemented and heavily tested         | C1-C12 rules; spec asks for 95% credits / 80% overall, but the CI gate is 75%/70% (AUD-06) |
| Job stage machine    | `libs/jobs`                | Implemented                            | Lease, heartbeat, checkpoints, retry/refund settlement                                     |
| Queue/retry layer    | `libs/queue`               | Implemented                            | BullMQ factories and shared retry presets                                                  |
| Object storage       | `libs/storage`             | Implemented                            | S3 adapter and traversal-safe keys; no in-repo storage provider mock                       |
| Email                | `libs/email`               | Implemented                            | Resend and SMTP adapters plus deterministic dev mock                                       |
| Observability        | `libs/observability`       | Implemented                            | Pino logger, metrics, shutdown hooks                                                       |
| Typed API client     | `packages/api-client`      | Generated                              | Regenerated from OpenAPI, never hand-edited                                                |

## 2. API endpoints by controller

### Auth and users

| Feature                    | Routes                                                                                 | Status                                     |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Register with signup bonus | `POST /auth/register`                                                                  | Implemented; integration-tested            |
| Login/refresh/logout       | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all` | Implemented                                |
| Current user               | `GET /auth/me`, `GET /me`                                                              | Implemented                                |
| Email verification         | `POST /auth/verify-email`, `POST /auth/resend-verification`                            | Implemented with Resend/SMTP/mock adapters |
| Password reset             | `POST /auth/forgot-password`, `POST /auth/reset-password`                              | Implemented                                |

### Workspaces, brands, campaigns, posts

| Feature                 | Routes                                                                                                         | Status                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Workspaces              | `GET /workspaces`, `GET /workspaces/:id`                                                                       | Implemented                                                |
| Members                 | `GET/POST /workspaces/:id/members`, `DELETE /workspaces/:id/members/:userId`                                   | Implemented                                                |
| Brands                  | `GET/POST /brands`, `GET/PATCH/DELETE /brands/:id`                                                             | Implemented, workspace-scoped                              |
| Campaign list for brand | `GET /brands/:id/campaigns`                                                                                    | Implemented                                                |
| Campaigns               | `POST /campaigns`, `GET /campaigns/:id`, `GET /campaigns/:id/posts`                                            | Implemented; no generic update/delete route in this commit |
| Posts                   | `GET/POST /posts`, `GET/PATCH /posts/:id`, `GET /posts/:id/assets`                                             | Implemented                                                |
| Approval                | `POST /posts/:id/approve`                                                                                      | Implemented                                                |
| Festival planning       | `GET /festival/occasions`, `GET /festival/templates`, `GET /festival/estimate`, `POST /campaigns/:id/festival` | Implemented                                                |
| Assets                  | `POST /assets/uploads`, `POST /assets/:id/confirm`, `GET /assets/:id/download`, `DELETE /assets/:id`           | Implemented with presigned S3 flow                         |

### Generation and jobs

| Feature               | Routes                       | Status                                                            |
| --------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Create generation job | `POST /posts/:id/generate`   | Implemented; credits reserved transactionally with job/outbox row |
| Job status            | `GET /jobs/:id`              | Implemented                                                       |
| Job progress stream   | `GET /jobs/:id/events` (SSE) | Implemented from durable checkpoints                              |

### Publishing and notifications

| Feature             | Routes                                                                                                                  | Status                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Schedule post       | `POST /posts/:id/schedule`                                                                                              | Implemented                                                                 |
| Reschedule / cancel | `PATCH /posts/:id/schedule`, `DELETE /posts/:id/schedule`                                                               | Implemented                                                                 |
| Publish history     | `GET /posts/:id/publishes`                                                                                              | Implemented                                                                 |
| Connected accounts  | `GET/POST /social-accounts`, `DELETE /social-accounts/:id`                                                              | Implemented; token connection is manual, no real OAuth exchange; see AUD-04 |
| Notifications       | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all` | Implemented                                                                 |

### Credits, analytics, admin, operations

| Feature                      | Routes                                                                                                                                                                 | Status                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Credit wallet/ledger summary | `GET /credits`                                                                                                                                                         | Implemented                         |
| Pricing rules                | `GET /credits/pricing`                                                                                                                                                 | Implemented; costs come from server |
| Stub top-up                  | `POST /credits/top-up`                                                                                                                                                 | Implemented; refused in production  |
| Analytics                    | `GET /analytics/overview`, `GET /analytics/campaigns/:id`                                                                                                              | Implemented                         |
| Admin DLQ/replay/reconcile   | `GET /admin/dlq`, `GET /admin/dlq/outbox`, `GET /admin/reconcile`, `POST /admin/dlq/:id/replay`, `POST /admin/dlq/outbox/:id/replay`, `POST /admin/publish/:id/replay` | Implemented                         |
| Admin credit adjustment      | `POST /admin/credits/adjust`                                                                                                                                           | Implemented                         |
| Health probes                | `GET /health/live`, `GET /health/ready` (unversioned)                                                                                                                  | Implemented                         |
| Metrics / OpenAPI            | `GET /metrics`, `GET /openapi.json` (unversioned)                                                                                                                      | Implemented                         |

## 3. Web routes

Actual App Router pages in `apps/web/src/app`:

- Marketing: `/`, `/about`, `/contact`, `/pricing`, `/privacy`, `/security`, `/terms`.
- Auth: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`.
- Product: `/dashboard`, `/brands`, `/brands/new`, `/brands/:brandId`, `/campaigns/:campaignId`, `/campaigns/:campaignId/festival`, `/posts/:postId`, `/calendar`, `/analytics`, `/notifications`, `/settings/accounts`, `/admin`.

## 4. Test coverage by feature area

- Unit tests: 96 suites, 1197 tests passing.
- Integration tests: 31 suites, 533 tests passing against real Postgres/Redis.
- Chaos tests: R1-R5, 40/40 passing.
- Browser journeys: 14/14 passing in both `chromium` and `mobile` projects; see `USER_FLOW_TESTS.md`.
- Credit invariants C1-C12 are covered in unit and integration suites.
- Multi-tenancy tests exist for workspace-scoped endpoints.

## 5. Provider modes

| Provider          | Mock implementation      | Real implementation                  | Production verification                                             |
| ----------------- | ------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| AI text/image/TTS | Yes, deterministic       | Interface and factory hooks exist    | BLOCKED: no credentials; production boot now refuses mock modes     |
| Social publish    | Yes, deterministic       | Not implemented in publisher runtime | BLOCKED: production boot refuses both mock and `real`; AUD-02       |
| Social metrics    | Yes, deterministic       | Instagram Graph adapter exists       | BLOCKED: no credentials                                             |
| Email             | Yes, deterministic       | Resend and SMTP adapters implemented | BLOCKED: no SMTP/Resend credentials                                 |
| Object storage    | Yes, deterministic/local | S3 adapter implemented               | BLOCKED: no S3 bucket/credentials                                   |
| Billing           | Stub top-up              | Not implemented                      | BLOCKED: no payment credentials; stub already refused in production |

## 6. Not implemented or incomplete

- Real OAuth authorization-code exchange and token refresh.
- Real social network publish adapters for LinkedIn, Instagram, Facebook, and WhatsApp.
- Live provider verification for AI, SMTP/Resend, S3, Instagram Graph, and billing.
- Docker Compose full-stack launch verification in this environment (no Docker daemon).

## 7. Source references

- API controllers: `apps/api/src/**/*.controller.ts`
- Worker entrypoints: `apps/*/src/main.ts`
- Web routes: `apps/web/src/app/`
- Shared contracts: `libs/common/src/`
- Database schema: `libs/db/src/schema.ts`
- Test suites: `tests/`, `apps/*/src/**/*.spec.ts`, `libs/*/src/**/*.spec.ts`
