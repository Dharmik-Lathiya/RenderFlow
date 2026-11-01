# Live Demo Deployment

How to deploy RenderFlow as a live interview demo using free/cheap services.
The demo uses mock AI providers — no real API keys needed, no real money spent.
The entire backend pipeline runs for real: credit engine, outbox, workers,
leases, checkpoints, chaos recovery.

**Target cost: ~$0–5/month**

---

## 1. Architecture of the demo deployment

```
Vercel (free)          Railway ($5/month)
┌──────────┐           ┌─────────────────────────────────────────┐
│ apps/web │ ────────► │ apps/api          (NestJS)               │
│ Next.js  │           │ apps/content-worker                      │
└──────────┘           │ apps/media-worker                        │
                       │ apps/publisher-worker                    │
                       │ apps/outbox-relay                        │
                       │ apps/reaper                              │
                       └─────────────┬───────────┬───────────────┘
                                     │           │
                         ┌───────────▼─┐   ┌─────▼──────┐
                         │ Neon (free) │   │Upstash(free│
                         │ PostgreSQL  │   │  Redis     │
                         └─────────────┘   └────────────┘
```

**Services used:**

| Service                                           | What for                  | Free tier              |
| ------------------------------------------------- | ------------------------- | ---------------------- |
| [Vercel](https://vercel.com)                      | Host `apps/web` (Next.js) | Free forever           |
| [Railway](https://railway.app)                    | Host API + all workers    | $5/month hobby plan    |
| [Neon](https://neon.tech)                         | PostgreSQL                | Free: 0.5 GB, 1 branch |
| [Upstash](https://upstash.com)                    | Redis (BullMQ)            | Free: 10k commands/day |
| [Cloudflare R2](https://r2.cloudflarestorage.com) | S3-compatible storage     | Free: 10 GB/month      |

---

## 2. Step-by-step setup

### Step 1 — Set up Neon (PostgreSQL)

1. Go to [neon.tech](https://neon.tech) → Sign up free
2. Create project: `renderflow`
3. Create database: `renderflow`
4. Copy the connection string — it looks like:
   ```
   postgresql://renderflow:<password>@ep-xxx.us-east-2.aws.neon.tech/renderflow?sslmode=require
   ```
5. Save as `DATABASE_URL`

### Step 2 — Set up Upstash (Redis)

1. Go to [upstash.com](https://upstash.com) → Sign up free
2. Create database: `renderflow`, region: closest to your Railway region
3. Copy the Redis URL — it looks like:
   ```
   redis://:password@us1-xxx.upstash.io:6379
   ```
   Or use the TLS URL: `rediss://...`
4. Save as `REDIS_URL`

### Step 3 — Set up Cloudflare R2 (S3-compatible storage)

1. Go to [Cloudflare R2](https://dash.cloudflare.com) → R2 → Create bucket: `renderflow`
2. Settings → R2 API tokens → Create token with read+write on this bucket
3. Copy: Account ID, Access Key ID, Secret Access Key
4. The S3 endpoint is: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

### Step 4 — Generate secrets

Run these locally and save the output:

```bash
# JWT secrets (must be 32+ characters)
openssl rand -base64 48   # → JWT_ACCESS_SECRET
openssl rand -base64 48   # → JWT_REFRESH_SECRET

# Token encryption key (exactly 32 bytes, base64 encoded)
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
```

### Step 5 — Deploy API to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select your RenderFlow repo
3. Railway auto-detects it is a monorepo

For each service, set the **root directory** and **start command**:

| Service          | Root directory          | Start command       |
| ---------------- | ----------------------- | ------------------- |
| api              | `apps/api`              | `node dist/main.js` |
| content-worker   | `apps/content-worker`   | `node dist/main.js` |
| media-worker     | `apps/media-worker`     | `node dist/main.js` |
| publisher-worker | `apps/publisher-worker` | `node dist/main.js` |
| outbox-relay     | `apps/outbox-relay`     | `node dist/main.js` |
| reaper           | `apps/reaper`           | `node dist/main.js` |

Or use a single `railway.toml` (see Step 5b below).

#### Step 5b — Add railway.toml to root

Create `railway.toml` in repo root:

```toml
[build]
builder = "nixpacks"

[[services]]
name = "api"
source = "apps/api"
startCommand = "node dist/main.js"

[[services]]
name = "content-worker"
source = "apps/content-worker"
startCommand = "node dist/main.js"

[[services]]
name = "media-worker"
source = "apps/media-worker"
startCommand = "node dist/main.js"

[[services]]
name = "publisher-worker"
source = "apps/publisher-worker"
startCommand = "node dist/main.js"

[[services]]
name = "outbox-relay"
source = "apps/outbox-relay"
startCommand = "node dist/main.js"

[[services]]
name = "reaper"
source = "apps/reaper"
startCommand = "node dist/main.js"
```

#### Step 5c — Set environment variables on Railway (api service)

```bash
NODE_ENV=production
DATABASE_URL=<neon connection string>
REDIS_URL=<upstash redis url>
JWT_ACCESS_SECRET=<generated above>
JWT_REFRESH_SECRET=<generated above>
TOKEN_ENCRYPTION_KEY=<generated above>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# Mock providers — no real API keys needed
AI_PROVIDER=mock
IMAGE_PROVIDER=mock
TTS_PROVIDER=mock
MOCK_LATENCY_MS=1500

# S3 / Cloudflare R2
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_BUCKET=renderflow
S3_ACCESS_KEY_ID=<r2 access key>
S3_SECRET_ACCESS_KEY=<r2 secret key>
S3_REGION=auto
S3_PATH_STYLE=true

# Email — none for demo (sends nothing)
EMAIL_PROVIDER=none

# CORS — will be updated after Vercel deploy
CORS_ORIGINS=https://renderflow.vercel.app

# Credits
SIGNUP_BONUS_CREDITS=50

# Signup bonus enough for several festival generations
```

Set the same `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY` on all worker
services. Workers only need the subset they use, but setting all of them is safe.

### Step 6 — Run migrations and seed on Railway

In Railway, open the `api` service terminal:

```bash
pnpm db:migrate
pnpm db:seed
```

Or add a one-time deploy command that runs migrations before starting.

### Step 7 — Deploy web to Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Root directory: `apps/web`
3. Framework preset: Next.js
4. Add environment variables:

```bash
NEXT_PUBLIC_API_URL=https://api-production.up.railway.app/api/v1
API_INTERNAL_URL=https://api-production.up.railway.app/api/v1
NEXT_PUBLIC_SITE_URL=https://renderflow.vercel.app
```

5. Deploy → Copy the Vercel URL
6. Go back to Railway → api service → update `CORS_ORIGINS` to the Vercel URL

### Step 8 — Create demo account

Once deployed, run this against the live API:

```bash
curl -X POST https://api-production.up.railway.app/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "demo@renderflow.dev",
    "password": "Demo1234!",
    "name": "Demo User"
  }'
```

Or the seed script creates it automatically if `SEED_DEMO_ACCOUNT=true` is set.

---

## 3. Demo account pre-seeded data

Set `SEED_DEMO_ACCOUNT=true` in the API environment. The seed script creates:

```
User:      demo@renderflow.dev / Demo1234!
Credits:   100 (double the normal signup bonus for a better demo)
Workspace: "Demo Workspace"
Brand:     "Denny's Bakery"
           primaryColor: #E67E22
           tagline: "Fresh baked every morning"
           logo: placeholder SVG
Campaign:  "November Festival Campaign"
Posts:     3 example posts in various states:
           - One COMPLETED (generated, approved, scheduled)
           - One PROCESSING (currently generating — use SSE demo)
           - One DRAFT
```

This means an interviewer can log in and immediately see a working dashboard
without having to create anything from scratch.

---

## 4. What the interviewer sees

| What they do                   | What they see                                             |
| ------------------------------ | --------------------------------------------------------- |
| Visit the URL                  | Marketing landing page, pricing page                      |
| Log in as demo@renderflow.dev  | Dashboard with 100 credits, pre-filled brand              |
| Click "Generate" on a new post | Credit reserved, SSE progress bar, stages completing      |
| Generation completes           | Credit captured, post ready for approval                  |
| Approve + Schedule             | Post scheduled, shows on calendar                         |
| View credit history            | Ledger entries: SIGNUP_BONUS, RESERVE, CAPTURE            |
| Force a failure                | Set `FAIL_RATE=0.5` in worker env → see REFUND on failure |

---

## 5. Show the architecture in the interview

With the live deploy running, you can show:

```bash
# Show the outbox working
curl https://api.up.railway.app/api/v1/admin/dlq/outbox \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Show credit reconciliation
curl https://api.up.railway.app/api/v1/admin/reconcile \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Show Prometheus metrics
curl https://api.up.railway.app/metrics | grep renderflow_
```

---

## 6. Keeping costs at zero

- **Neon free tier:** 0.5 GB storage, scales to zero when inactive. Fine for demo.
- **Upstash free tier:** 10,000 Redis commands/day. Demo usage is ~20 commands per
  generation job. 10,000 commands = ~500 generation jobs/day. More than enough.
- **Cloudflare R2 free tier:** 10 GB storage, 10M read operations/month. Fine.
- **Vercel free tier:** Unlimited hobby deploys.
- **Railway hobby plan:** $5/month flat. Covers all 6 services.

**Total: $5/month** (Railway only) while the demo is active. Delete the Railway
project when the job search is over.

---

## 7. Protecting the demo

To prevent random internet users from abusing the demo deployment:

1. Set `SIGNUP_BONUS_CREDITS=10` — new signups get 10 credits, not 50. Enough to
   see one or two generations but not enough to abuse the system.
2. Set tight rate limits:
   ```
   RATE_LIMIT_REGISTER=3/1h    # 3 signups per IP per hour
   RATE_LIMIT_GENERATE=5/1h    # 5 generations per user per hour
   ```
3. Do not publicise the URL. Share it only in interview contexts.
4. The demo account with 100 credits is hardcoded and refilled by the seed
   script if needed.

---

## 8. Checklist before sharing the URL

- [ ] `NODE_ENV=production` on all services
- [ ] Real JWT secrets (not the dev placeholders from `.env.example`)
- [ ] `CORS_ORIGINS` set to your Vercel URL only
- [ ] `EMAIL_PROVIDER=none` (not `log`)
- [ ] `BILLING_PROVIDER=stub` is the default — check it is NOT set to anything real
- [ ] `BULL_BOARD_ENABLED=false`
- [ ] Migrations ran: `pnpm db:migrate`
- [ ] Seed ran: `pnpm db:seed`
- [ ] Demo account created and has 100 credits
- [ ] Login works: `demo@renderflow.dev` / `Demo1234!`
- [ ] Generate a post and confirm credits are deducted
- [ ] SSE progress bar works end to end
