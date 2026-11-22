# Deploying the backend to Render (demo/staging)

The live 404 on `/api/v1/auth/register` happened because **the backend was never
hosted**. Vercel only serves the web app; its `/api/v1/*` rewrite needs a real API
origin. Deploy the backend with the checked-in `render.yaml` Blueprint.

## 1. Do NOT deploy `apps/api` as the root

RenderFlow is a pnpm monorepo. `apps/api` imports `libs/common`, `libs/db`,
`libs/credits`, etc., so a deploy rooted at `apps/api` cannot install or build the
workspace. The Blueprint builds from the **repository root** with the root
`pnpm` scripts and starts each workspace with `node apps/<package>/dist/main.js`.

## 2. Create the stack

1. Render Dashboard → **New → Blueprint**.
2. Connect the GitHub repository and select branch `main`.
3. Render reads `render.yaml` at the repo root and creates:
   - `renderflow-db` (Postgres)
   - `renderflow-redis` (Key Value)
   - `renderflow-api` (web, `https://renderflow-nvgh.onrender.com`)
   - content, media, publisher, analytics, outbox-relay and reaper workers
4. The API service's `initialDeployHook` runs `pnpm db:migrate:deploy && pnpm
db:seed` once after its first successful deploy. If that hook is unavailable
   on your plan, run those two commands from the Render Shell for the API
   service before testing signup.

## 3. Vercel web env (already applied by this change)

Set on the Vercel project `renderflow`:

```bash
NEXT_PUBLIC_API_URL=/api/v1
API_INTERNAL_URL=https://renderflow-nvgh.onrender.com/api/v1
NEXT_PUBLIC_SITE_URL=https://renderflowapp.vercel.app
```

`NEXT_PUBLIC_API_URL` stays relative so the browser calls the same origin and
cookies remain first-party. `API_INTERNAL_URL` must be an absolute URL; it is
read by `apps/web/next.config.ts` at build time and is where the `/api/v1/*`
rewrite forwards. Next bakes rewrites into the build, so changing it requires a
new Vercel deployment. A relative value here previously caused a self-rewrite to
`/_not-found` and a 404 on signup.

A new push to `main` redeploys Vercel with these values. The proxy only handles
`/api/v1/*`, while health is mapped at `/health/live`; verify them separately:

```bash
curl -fsS https://renderflow-nvgh.onrender.com/health/live
curl -sS -X POST https://renderflowapp.vercel.app/api/v1/auth/register \
  -H 'content-type: application/json' -d '{}'
```

The second command should return Nest validation JSON (`400`) with `email`,
`password` and `name` errors. A `Cannot GET /api/v1/health/live` JSON response
means the Vercel rewrite is working and the path is simply not mapped.

### Signup returns 500 with `relation "users" does not exist`

The API is connected to Postgres, but migrations did not run. This happens when
the service was created manually instead of from the Blueprint, because there is
no `initialDeployHook`.

Render Shell requires a paid compute plan. On the free plan, copy the API's
`DATABASE_URL` from Render → API service → **Environment** (or use the Postgres
service's **External Connection String**), then run the migration locally from
the repository root:

```bash
DATABASE_URL='copied-postgres-connection-string' pnpm db:migrate:deploy
DATABASE_URL='copied-postgres-connection-string' pnpm db:seed
```

On PowerShell:

```powershell
$env:DATABASE_URL='copied-postgres-connection-string'
pnpm db:migrate:deploy
pnpm db:seed
```

Never commit the copied URL. Both commands must succeed before testing signup
again. `db:seed` inserts the `pricing_rules` rows required by generation. If the
connection is refused from your home network, temporarily allow your public IP
on the Render Postgres instance.

## 4. Required runtime secrets

The API validates JWT secrets at boot. If either value is shorter than 32
characters, the service exits before it binds a port with:

```text
AuthConfigError: Invalid auth configuration:
  - JWT_ACCESS_SECRET: JWT_ACCESS_SECRET must be at least 32 characters
  - JWT_REFRESH_SECRET: JWT_REFRESH_SECRET must be at least 32 characters
```

Set both secrets in the Render service (or Blueprint `envVars`) to independent
random values of at least 32 characters:

```bash
node -e "const c=require('crypto'); for (const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET']) console.log(k+'='+c.randomBytes(48).toString('base64url'))"
```

Do not commit the generated values. After changing them, trigger a manual
deploy and verify with `curl -fsS https://renderflow-nvgh.onrender.com/health/live`.

## 5. Demo-only limitations

The Blueprint sets `NODE_ENV=development` and mock AI/social providers. This is
intentional: the production guards refuse mock providers in `production`, and
there are no real provider credentials or publish adapters yet. Consequences:

- signup/login, workspaces, brands, campaigns, credits and the browser journey
  work;
- generated captions/images/reels are placeholders;
- uploads need a real S3-compatible bucket (the values in the Blueprint are
  placeholders that only let the API boot);
- social publishing is unavailable.

See `docs/engineering-audit/FINAL_PRODUCTION_REPORT.md` for the full
`NOT PRODUCTION READY` decision and the ordered remediation list.

## 6. Runtime configuration (do not re-add corepack)

The Blueprint owns every build and start command. Do not add `corepack enable`
to a Render service: pnpm is pinned by `packageManager` in the root
`package.json`, and Render's native Node runtime provisions it. Corepack is
not bundled with Node 25+, and a broken shim fails before any app code runs.
The same rule applies to the Vercel project, whose `installCommand` is
`pnpm install --frozen-lockfile` in `vercel.json`.

| Setting         | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| Node            | `24.21.0`, pinned in the root `.node-version`               |
| Root directory  | repository root (not `apps/api`)                            |
| Build command   | `pnpm install --frozen-lockfile && pnpm build`              |
| API start       | `node apps/api/dist/main.js`                                |
| Worker start    | `node apps/<worker>/dist/main.js`                           |
| Migrations/seed | `initialDeployHook: pnpm db:migrate:deploy && pnpm db:seed` |

The start commands call `node` directly on purpose. `pnpm --filter <pkg> start`
is a recursive run; pnpm 12 reports a termination signal as
`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` and exits 1, so Render can mark a healthy
deploy as failed while the API is mapping its routes. Running Node directly
lets the app's own SIGTERM handler drain and return the real exit status.

`PORT` is supplied by Render and must not be overridden in the service.
`apps/api/src/config/env.ts` uses it as the fallback for `API_PORT`; an
explicit `API_PORT` still wins. `/health/live` is the liveness check, and
`/health/ready` is the dependency gate used before traffic is routed.

Redis is injected as `REDIS_HOST` and `REDIS_PORT` from the Key Value service's
`host` and `port` properties. Render internal connections need no credentials, so
the app builds a clean `redis://<host>:<port>` URL. `libs/queue` gives these
provider-managed values precedence over `REDIS_URL`, which matters because Render
preserves old environment variables when a Blueprint sync removes them: a stale
`connectionString` left in `REDIS_URL` can no longer shadow the new values. The
tolerant URL parser remains for other hosts whose connection string contains raw
`/`, `+`, `=` or `@` in the password. Do not hand-write a placeholder in the
Render dashboard.

If Render logs `IMPORTANT! Eviction policy is allkeys-lru. It should be
"noeviction"`, open `renderflow-redis` → **Settings** → **Maxmemory Policy** and
select `noeviction`. Queue jobs must never be evicted while waiting; `allkeys-lru`
can silently drop them.

If the deploy log ends with `"pnpm recursive run" failed in .../apps/api`,
check that the start command in the Render dashboard has not been overridden
with `pnpm --filter ... start`. Re-syncing the Blueprint restores the direct
`node` command. Verify with:

```bash
curl -fsS https://renderflow-nvgh.onrender.com/health/live
```
