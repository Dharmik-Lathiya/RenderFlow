# Deployment

This is the production deployment guide for RenderFlow. It covers the runtime
topology, required configuration, release order, smoke checks and rollback.

The repository ships container images for the API and workers, a Next.js image
and a Vercel configuration. It does **not** ship Kubernetes manifests, Terraform,
a managed-database module or an alert delivery service. The operator supplies
those.

**Verified against:** repository at 2026-11-02. The compose stack is a local
development environment, not a production deployment.

## 1. Current deployment state

| Surface                       | Status                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| Web on Vercel                 | Ready at `https://renderflowapp.vercel.app`. Marketing pages only. |
| `NEXT_PUBLIC_API_URL`         | Not set. The deployed site has no API host.                        |
| API host                      | None. No public API is currently deployed.                         |
| AI / social / email / billing | Mock or disabled. No real provider has been connected.             |
| Production database           | Not provisioned by this repository.                                |

The browser calls the same-origin relative path `/api/v1`, which `next.config.ts`
rewrites to `API_INTERNAL_URL` (or `NEXT_PUBLIC_API_URL` when set). The client
never falls back to `localhost`, so setting one runtime environment variable
repoints the deployed app at the backend - no rebuild required. The public
marketing pages render either way, but sign-in and the product screens cannot
work until the API host and rewrite target are ready. Do not publish an API URL
until the API host, CORS origin, cookie policy and secrets are ready.

## 2. Topology

```text
                    ┌──────────────────────────┐
   browser ───────► │ web (Next.js or Vercel)   │
                    └────────────┬─────────────┘
                                 │ HTTPS, REST + SSE
                    ┌────────────▼─────────────┐
                    │ api (NestJS)             │
                    └───┬──────────┬───────────┘
                        │          │
              ┌─────────▼──┐   ┌───▼─────────────┐
              │ PostgreSQL │   │ S3-compatible   │
              │ source of  │   │ object storage  │
              │ truth      │   └─────────────────┘
              └─────┬──────┘
                    │ outbox
          ┌─────────▼─────────┐        ┌─────────────────────┐
          │ outbox-relay      │───────►│ Redis / BullMQ      │
          └───────────────────┘        └──┬──────┬──────┬────┘
                                          │      │      │
                              content ◄───┘      │      └───► publisher
                              media   ◄──────────┘      └───► analytics
                                          reaper (DB sweeps, no queue)
```

Minimum production services:

- one API instance (see the scaling caveat),
- one instance of each worker: content, media, publisher, analytics,
  outbox-relay, reaper,
- PostgreSQL 16 with backups,
- Redis 7 with persistence appropriate to your tolerance for delayed wake-ups,
- S3-compatible object storage with a private bucket,
- a reverse proxy or load balancer that terminates TLS and overwrites
  `X-Forwarded-For`,
- a secrets manager,
- a metrics store and alert delivery path.

The API and web app must be on the same registrable site because auth cookies are
`SameSite=Lax`. For example: `app.example.com` and `api.example.com`.

## 3. Build artifacts

All Node services use one multi-stage Dockerfile:

```bash
TAG=2026.10.31

docker build \
  -f infra/docker/node-app.Dockerfile \
  --build-arg APP_DIR=apps/api \
  --build-arg APP_NAME=@renderflow/api \
  -t registry.example.com/renderflow/api:$TAG .

docker build \
  -f infra/docker/node-app.Dockerfile \
  --build-arg APP_DIR=apps/content-worker \
  --build-arg APP_NAME=@renderflow/content-worker \
  -t registry.example.com/renderflow/content-worker:$TAG .
```

Repeat for each worker with the matching directory and package name:

| App              | `APP_DIR`               | `APP_NAME`                     |
| ---------------- | ----------------------- | ------------------------------ |
| API              | `apps/api`              | `@renderflow/api`              |
| Content worker   | `apps/content-worker`   | `@renderflow/content-worker`   |
| Media worker     | `apps/media-worker`     | `@renderflow/media-worker`     |
| Publisher worker | `apps/publisher-worker` | `@renderflow/publisher-worker` |
| Analytics worker | `apps/analytics-worker` | `@renderflow/analytics-worker` |
| Outbox relay     | `apps/outbox-relay`     | `@renderflow/outbox-relay`     |
| Reaper           | `apps/reaper`           | `@renderflow/reaper`           |

The web image is built separately:

```bash
docker build \
  -f infra/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 \
  -t registry.example.com/renderflow/web:$TAG .
```

`NEXT_PUBLIC_API_URL` is baked into the browser bundle at build time. Changing it
requires a rebuild, not just a restart.

For Vercel, the repository root `vercel.json` sets the framework, install command,
build command and output directory. The project's **Root Directory** must be
`apps/web`; this is a dashboard setting that `vercel.json` cannot express.
`scripts/vercel-setup.sh` applies the project settings idempotently after
`vercel link`.

## 4. Configuration

Use environment variables or a secrets manager. Never bake secrets into an image
or commit them. At minimum:

### Required in every environment

| Variable               | Notes                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `NODE_ENV`             | `production` for deployed services.                                   |
| `DATABASE_URL`         | PostgreSQL connection string with TLS as required by the provider.    |
| `REDIS_URL`            | `rediss://` when the provider requires TLS.                           |
| `JWT_ACCESS_SECRET`    | At least 32 characters. No fallback; boot fails if weak.              |
| `JWT_REFRESH_SECRET`   | At least 32 characters.                                               |
| `TOKEN_ENCRYPTION_KEY` | Base64 of exactly 32 bytes. Stable; rotating it breaks stored tokens. |
| `CORS_ORIGINS`         | Explicit HTTPS origin(s) of the web app. Never `*`.                   |
| `WEB_BASE_URL`         | Public web origin, used in email links.                               |
| `S3_ENDPOINT`          | S3-compatible endpoint.                                               |
| `S3_REGION`            | Bucket region.                                                        |
| `S3_BUCKET`            | Private asset bucket.                                                 |
| `S3_ACCESS_KEY`        | Least-privilege access key.                                           |
| `S3_SECRET_KEY`        | Secret key.                                                           |
| `S3_FORCE_PATH_STYLE`  | `true` for MinIO; usually `false` for AWS S3.                         |
| `API_PORT`             | Default `4000`.                                                       |
| `METRICS_PORT`         | Per-process scrape port: API `4000`; workers `4001`-`4006`.           |

Generate secrets with `openssl rand -base64 48` for JWT secrets and
`openssl rand -base64 32` for `TOKEN_ENCRYPTION_KEY`.

### Production-safe feature settings

| Variable                    | Recommended            | Why                                                                                                                             |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`            | `resend`               | Needs `RESEND_API_KEY` and a verified `EMAIL_FROM` domain. `log` and `mailhog` are refused in production; `none` sends no mail. |
| `RESEND_API_KEY`            | secret                 | Required when `EMAIL_PROVIDER=resend`.                                                                                          |
| `EMAIL_FROM`                | verified address       | Sender for reset, verification and publish-failure mail.                                                                        |
| `RATE_LIMIT_STORE`          | `redis`                | `memory` multiplies limits by the replica count.                                                                                |
| `TRUST_PROXY`               | hop count (`1`)        | `false` behind no proxy; never `true` on a public API.                                                                          |
| `BILLING_PROVIDER`          | `disabled`             | `stub` mints credits and is refused in production.                                                                              |
| `BULL_BOARD_ENABLED`        | `false`                | Board exposes cross-tenant job payloads.                                                                                        |
| `AI_PROVIDER`               | `mock` until validated | Real provider keys have never been exercised.                                                                                   |
| `IMAGE_PROVIDER`            | `mock` until validated | Same.                                                                                                                           |
| `TTS_PROVIDER`              | `mock` until validated | Same.                                                                                                                           |
| `SOCIAL_PROVIDER`           | `mock` until validated | No live OAuth flow has been implemented or verified.                                                                            |
| `METRICS_ENABLED`           | `true`                 | Enables process metrics.                                                                                                        |
| `METRICS_COLLECTOR_ENABLED` | `true`                 | Enables database-derived business gauges.                                                                                       |
| `METRICS_INTERVAL_MS`       | `15000` or more        | Must not be shorter than the Prometheus scrape interval.                                                                        |

Keep every rate-limit variable at its documented default unless there is an
incident-specific reason to change it. A bare `0` disables a rule; an unparseable
value fails boot.

Keep the lease invariants:

```text
HEARTBEAT_SECONDS <= JOB_LEASE_SECONDS / 2
PUBLISH_HEARTBEAT_SECONDS <= PUBLISH_LEASE_SECONDS / 2
```

Workers and the reaper validate these at boot.

### Web/Vercel variables

| Variable                    | Where         | Notes                                                                   |
| --------------------------- | ------------- | ----------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`       | Build time    | Browser base URL including `/api/v1`; rebuild after changing it.        |
| `API_INTERNAL_URL`          | Runtime       | Server-side reads such as the pricing page; defaults to the public URL. |
| `NEXT_PUBLIC_SITE_URL`      | Build/runtime | Canonical origin for metadata, sitemap and robots.                      |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Build time    | Public support address. Do not use a placeholder in production.         |

Only `NEXT_PUBLIC_*` values reach the browser. Never put a secret behind that
prefix.

## 5. Release order

### Step 1 — Preflight

- [ ] A recent database backup exists and the restore drill passed.
- [ ] Secrets are present in the target environment and match the intended
      deployment.
- [ ] `CORS_ORIGINS` contains the exact web origin.
- [ ] DNS/TLS certificates are ready for both web and API hosts.
- [ ] The API hostname is on the same registrable site as the web app.
- [ ] `TRUST_PROXY` matches the edge: `false` with no proxy, or the number of
      trusted hops. The proxy overwrites `X-Forwarded-For`.
- [ ] `RATE_LIMIT_STORE=redis` if more than one API replica will run.
- [ ] `EMAIL_PROVIDER` and `BILLING_PROVIDER` are safe for production.
- [ ] You know which image tag is currently deployed, for rollback.

### Step 2 — Migrate the database

Run migrations as a release job before starting the new API or workers:

```bash
DATABASE_URL=... pnpm install --frozen-lockfile
DATABASE_URL=... pnpm build
DATABASE_URL=... pnpm db:migrate:deploy
```

`db:migrate:deploy` is currently an alias for `db:migrate`; both run Drizzle
migrations. Do not run migrations automatically from every API replica.

Seed pricing once per environment, after migrations:

```bash
DATABASE_URL=... pnpm db:seed
```

The seeder is idempotent and updates existing active prices from
`DEFAULT_PRICES`. A missing `pricing_rules` row makes generation fail rather than
charging a guessed price.

There are no down migrations. Migrations are forward-only. Use expand/contract
changes when a rollback must remain possible.

### Step 3 — Start the API

Deploy the API image with the production environment. It should:

- listen on `API_PORT`,
- pass `GET /health/live`,
- serve `GET /metrics`,
- reach PostgreSQL, Redis and S3,
- accept requests only from the configured web origin.

Use `/health/ready` as the dependency gate: it probes PostgreSQL, Redis and S3
and returns 503 when any is down. `/health/live` answers without touching a
dependency, so a transient outage does not cause an unnecessary restart.

### Step 4 — Start the workers

Start each worker image with the same database, Redis, S3, provider and lease
configuration as the API. Workers do not serve the product API, but each one
exposes `GET /metrics` on its own `METRICS_PORT` for Prometheus:

| Worker             | Default metrics port | Notes                                                                                                                     |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `content-worker`   | `4001`               | Required for PLAN/SCRIPT and festival copy.                                                                               |
| `media-worker`     | `4002`               | Required for IMAGE/VOICE/RENDER and festival posters/reels; needs FFmpeg and `fonts-dejavu-core` (included in the image). |
| `publisher-worker` | `4003`               | Required for scheduled publishing and the `notifications` consumer.                                                       |
| `analytics-worker` | `4004`               | Optional for publishing; required for metrics snapshots.                                                                  |
| `outbox-relay`     | `4005`               | Must run for any generation or schedule to leave PostgreSQL.                                                              |
| `reaper`           | `4006`               | Required for crash recovery and stale publish reclaim.                                                                    |

Do not publish these ports to the internet; scrape them over the private
network. Restrict `/metrics` at the proxy if a port is exposed.

All workers handle `SIGTERM` gracefully. Give the orchestrator a termination
grace period longer than the configured drain timeout.

### Step 5 — Deploy the web app

For Vercel:

1. Link the repository to the project.
2. Set the project Root Directory to `apps/web`.
3. Set `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_SITE_URL` and
   `NEXT_PUBLIC_SUPPORT_EMAIL`.
4. Run `scripts/vercel-setup.sh` if the project settings need to be re-applied.
5. Deploy and confirm the production alias.

For the container image, pass the same public values as build args where
required, and set `API_INTERNAL_URL` at runtime.

### Step 6 — Smoke test

Run these against the public aliases, not an SSO-protected deployment URL:

```bash
curl -fsS https://api.example.com/health/live
curl -fsS https://api.example.com/metrics | grep renderflow_
curl -fsS https://api.example.com/api/v1/credits/pricing
curl -fsSI https://app.example.com/ | head -20
```

For each worker, scrape its metrics port over the private network:

```bash
curl -fsS http://content-worker.internal:4001/metrics | grep renderflow_
```

Then, in a browser:

1. Load the public landing page and pricing page.
2. Register a user and confirm the signup bonus appears once.
3. Create a brand and campaign.
4. Generate a caption with mock providers, or with the provider you validated.
5. Confirm the job reaches `COMPLETED` and credits are captured.
6. Schedule a post to a mock social account and confirm it publishes once.
7. Confirm a failed job is refunded and appears in the notification centre.
8. Open the campaign, choose **Festival campaign**, pick an occasion and
   template, enter an offer and CTA, and generate a poster. Confirm the job
   advances PLAN → SCRIPT → IMAGE, the post becomes `READY`, the poster
   downloads, and the estimate matched the captured credits. Repeat with the
   reel enabled on a host that has FFmpeg and the DejaVu fonts.
9. Confirm `/metrics` reports `renderflow_jobs_by_status`,
   `renderflow_outbox_pending` and `renderflow_ledger_drift_users == 0`.

## 6. Vercel specifics

The repository's `vercel.json` is:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "installCommand": "corepack enable && pnpm install --frozen-lockfile",
  "buildCommand": "pnpm turbo run build --filter=@renderflow/web...",
  "outputDirectory": ".next"
}
```

The Root Directory setting (`apps/web`) lives in the Vercel dashboard. Without
it, Vercel builds the repository root, finds no Next.js app, and deploys an output
with no routes that answers 404 even though the build succeeds.

The current production project has only `NEXT_PUBLIC_SITE_URL` configured. It is
a marketing deployment. Set `API_INTERNAL_URL` (runtime, read by the rewrite in
`next.config.ts`) to the deployed API's public origin once the API is live;
auth then works without baking any URL into the bundle.

## 7. Rollback

1. Stop routing new traffic to the bad API/worker version.
2. Redeploy the previous image tag.
3. Do **not** roll back the database with a destructive script; there are no down
   migrations. If the new schema is incompatible with the old image, fix forward
   or restore into a separate database and cut over.
4. Confirm `/health/live`, `/metrics`, pricing and a generation path.
5. Check the outbox for a backlog and let the relay drain it.
6. Check `publish_jobs` for jobs that may have been claimed during the rollback;
   the reaper reclaims expired leases.

A web-only rollback is safe if the API contract is unchanged. A schema-changing
release needs an expand/contract plan before rollout.

## 8. Scaling and high availability

Set `RATE_LIMIT_STORE=redis` before running more than one API replica. The store
uses one atomic Lua increment across replicas; with `memory`, N replicas
multiply every configured limit by N. A Redis outage degrades to allowing
traffic rather than failing the API closed, so keep the API's own rate limits
as the first line of defence and the edge/WAF as the second.

`TRUST_PROXY` must match the proxy chain. `req.ip` is the only source of the
client address; a raw `X-Forwarded-For` header is never parsed.

Content, media, publisher and relay workers can scale independently. Analytics
and reaper use PostgreSQL advisory locks and are single-leader: a second replica
loses the lock and exits cleanly, so it is not a hot spare. Give those two an
orchestrator restart policy instead of running them as a redundant pair.
Publisher workers claim rows with leases and check `external_post_id` before
retrying.

For high availability:

- run PostgreSQL with a managed failover replica and tested backups,
- run Redis with persistence and a replica if delayed wake-ups matter,
- use a private S3 bucket with versioning and lifecycle rules,
- run two or more API replicas only after `RATE_LIMIT_STORE=redis`,
- run two or more content, media, publisher and relay workers where the queue can
  absorb it,
- run one analytics worker and one reaper, each with restart-on-exit,
- terminate TLS at a proxy that overwrites `X-Forwarded-For`,
- scrape every worker's `METRICS_PORT` over the private network,
- deploy Alertmanager or an equivalent alert path.

## 9. Demo deployment

The portfolio demo is a smaller version of the same topology, with no real
provider keys:

```text
Vercel (free)                 Railway ($5 hobby) or one compose host
┌──────────┐                  ┌─────────────────────────────────────────┐
│ apps/web │ ───────────────► │ apps/api, content-worker, media-worker, │
│ Next.js  │                  │ publisher-worker, outbox-relay, reaper  │
└──────────┘                  └───────┬──────────────────┬──────────────┘
                                      │                  │
                              ┌───────▼──────┐   ┌───────▼───────┐
                              │ Neon Postgres│   │ Upstash Redis │
                              └──────────────┘   └───────────────┘
                                      │
                              ┌───────▼────────────┐
                              │ Cloudflare R2      │
                              └────────────────────┘
```

The full setup checklist lives in [`issues/DEPLOYMENT-DEMO.md`](./issues/DEPLOYMENT-DEMO.md).
Two things matter beyond the production guide:

1. **Set `RATE_LIMIT_STORE=redis` and `TRUST_PROXY=1`.** Railway and Vercel sit
   in front of the API; `memory` limits and an ignored forwarded header both
   look healthy while allowing more traffic than configured.
2. **Verify the backup path before the interview.** Neon's point-in-time restore
   is the demo default; `scripts/backup-to-s3.sh` is the portable daily dump for
   a self-hosted database. Run `scripts/backup-restore-check.sh` against the
   provider at least once so the RPO in the interview is a measured number, not
   a plan.

Demo credentials and the seeded brand/campaign come from
`scripts/seed-demo.mjs`. It talks to the public API rather than inserting rows, so
the demo wallet reconciles with its ledger. Run it after `pnpm db:seed`:

```bash
BASE_URL=https://api.example.com \
DEMO_ACCOUNT_EMAIL=demo@renderflow.dev \
DEMO_ACCOUNT_PASSWORD='Demo1234!' \
ADMIN_TOKEN=... \
node scripts/seed-demo.mjs
```

## 10. What is not deployable yet

- Real social OAuth and publishing.
- Real AI providers (adapters exist, but no live call has been verified).
- Real billing (the stub is refused in production).
- A production API host in the current Vercel deployment.
- Alert delivery, despite alert rules.

Email delivery is implemented for Resend and SMTP, but no live message has been
accepted by a provider in this repository's verification. Verify the sender
domain and send a password-reset message before treating it as production-ready.
Postgres backup automation is documented and the scripts are CI-shell-checked;
Neon PITR (demo) or the S3 dump schedule (self-hosted) still has to be enabled in
the operator's account.

Treat these as launch gates, not as configuration details. They are tracked in
[`PHASES.md`](./PHASES.md), [`SECURITY.md`](./SECURITY.md) and
[`OPERATIONS.md`](./OPERATIONS.md).
