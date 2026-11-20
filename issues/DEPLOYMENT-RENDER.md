# Deploying the backend to Render (demo/staging)

The live 404 on `/api/v1/auth/register` happened because **the backend was never
hosted**. Vercel only serves the web app; its `/api/v1/*` rewrite needs a real API
origin. Deploy the backend with the checked-in `render.yaml` Blueprint.

## 1. Do NOT deploy `apps/api` as the root

RenderFlow is a pnpm monorepo. `apps/api` imports `libs/common`, `libs/db`,
`libs/credits`, etc., so a deploy rooted at `apps/api` cannot install or build the
workspace. The Blueprint builds from the **repository root** with the root
`pnpm` scripts and starts each workspace with `pnpm --filter <package> start`.

## 2. Create the stack

1. Render Dashboard → **New → Blueprint**.
2. Connect the GitHub repository and select branch `main`.
3. Render reads `render.yaml` at the repo root and creates:
   - `renderflow-db` (Postgres)
   - `renderflow-redis` (Key Value)
   - `renderflow-api` (web, `https://renderflow-api.onrender.com`)
   - content, media, publisher, analytics, outbox-relay and reaper workers
4. The API service's `initialDeployHook` runs `pnpm db:migrate:deploy && pnpm
db:seed` once after its first successful deploy. If that hook is unavailable
   on your plan, run those two commands from the Render Shell for the API
   service before testing signup.

## 3. Vercel web env (already applied by this change)

Set on the Vercel project `renderflow`:

```bash
NEXT_PUBLIC_API_URL=/api/v1
API_INTERNAL_URL=https://renderflow-api.onrender.com/api/v1
NEXT_PUBLIC_SITE_URL=https://renderflowapp.vercel.app
```

`NEXT_PUBLIC_API_URL` stays relative so the browser calls the same origin and
cookies remain first-party. `API_INTERNAL_URL` is read at runtime by
`apps/web/next.config.ts` and is where the `/api/v1/*` rewrite forwards.

A new push to `main` redeploys Vercel with these values. Verify:

```bash
curl -fsS https://renderflowapp.vercel.app/api/v1/health/live
curl -fsS https://renderflow-api.onrender.com/health/live
```

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
deploy and verify with `curl -fsS https://renderflow-api.onrender.com/health/live`.

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
