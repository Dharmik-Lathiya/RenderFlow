# Security Issues

All security gaps found in `SECURITY.md` and `ARCHITECTURE.md` after a full audit
of the codebase on 2026-11-01. Each issue has its source, impact, and a concrete
fix plan so it can be turned into a task immediately.

---

## 🔴 Critical — fix before any real user traffic

---

### SEC-01 — Readiness endpoint has no dependency probes

**Source:** `ARCHITECTURE.md §2`, `SECURITY.md §14`, `OPERATIONS.md §2`

**Problem:**
`GET /health/ready` returns `{ "status": "ok", "checks": {} }` without checking
PostgreSQL, Redis or S3. A broken database connection will still report healthy.
Any orchestrator (Railway, Render, Kubernetes) relying on this probe will send
traffic to a dead instance.

**Impact:** Production traffic routed to an instance that cannot serve requests.
Silent failure — no alert fires, load balancer does not remove the instance.

**Fix plan:**

1. In `apps/api/src/modules/health/health.service.ts`, register three probes:
   - PostgreSQL: run `SELECT 1` with a 2s timeout
   - Redis: run `PING` with a 2s timeout
   - S3: run `headBucket` on the configured bucket with a 3s timeout
2. Return `{ status: "ok"|"degraded", checks: { db, redis, s3 } }`
3. Return HTTP 503 if any probe fails so the load balancer removes the instance
4. Add an integration test: disconnect Postgres → expect 503

**Effort:** ~2 hours

---

### SEC-02 — In-process rate limiter multiplies with API replicas

**Source:** `SECURITY.md §11`, `ARCHITECTURE.md §12`

**Problem:**
Rate limits (login: 10/15m, generate: 30/1h, etc.) are stored in-process memory.
If you run 2 API replicas, the effective limit becomes 20 logins per 15 minutes.
An attacker hitting different replicas round-robin bypasses the limit entirely.

**Impact:** Brute-force protection and generation abuse limits are broken at scale.

**Fix plan:**

1. Add `rate-limiter-flexible` with a Redis store (already have Redis in the stack)
2. In the rate-limit config module, add `RATE_LIMIT_STORE=redis` env option
3. When `RATE_LIMIT_STORE=redis`, use `RateLimiterRedis` backed by `REDIS_URL`
4. Keep in-memory as fallback for local dev only
5. Document: do not run >1 API replica without `RATE_LIMIT_STORE=redis`

**Effort:** ~3 hours

---

### SEC-03 — X-Forwarded-For is trusted as-supplied (IP spoofing)

**Source:** `SECURITY.md §11`, `OPERATIONS.md §10`

**Problem:**
The rate limiter uses the client IP as a key. `X-Forwarded-For` is read directly
without validating that it comes from a trusted proxy. A direct client can send
`X-Forwarded-For: 1.2.3.4` and spoof any IP, making IP-based rate limits useless.

**Impact:** Any IP-scoped rate limit (login, register, forgot-password) can be
bypassed by spoofing the header.

**Fix plan:**

1. Set `trust proxy` configuration in NestJS/Express to only trust the known
   proxy IPs (Railway/Render/Vercel edge IP ranges)
2. Or: enforce at the infrastructure level — put a proxy (Cloudflare, nginx)
   that overwrites the header before the API receives the request
3. In `DEPLOYMENT.md`, add explicit note: "The API must never be directly
   reachable from the internet — it must sit behind a proxy"
4. Add a boot-time check: if `NODE_ENV=production` and `TRUST_PROXY` is not set,
   log a warning

**Effort:** ~1 hour (config) + infra setup

---

### SEC-04 — No real email provider — password reset is broken in production

**Source:** `SECURITY.md §3`, `OPERATIONS.md §11`

**Problem:**
`EMAIL_PROVIDER=log` is refused at boot (correctly). But the only safe alternative
is `EMAIL_PROVIDER=none`, which silently sends nothing. A user who clicks
"forgot password" gets no email. No error is shown.

**Impact:** Password recovery is completely broken for real users. Email
verification for new signups also does not work.

**Fix plan:**

1. Implement `EMAIL_PROVIDER=resend` using [Resend](https://resend.com) — free
   tier: 3000 emails/month, no credit card needed
2. Add `RESEND_API_KEY` to `.env.example` with instructions
3. The `EmailSender` interface already exists — just add the Resend adapter
4. For the demo deployment, use Resend free tier
5. For local dev, keep `EMAIL_PROVIDER=log` blocked but allow a new
   `EMAIL_PROVIDER=mailhog` that sends to the local MailHog container
   (already in `docker-compose.yml`)

**Effort:** ~3 hours

---

### SEC-05 — Upload MIME type is not verified against actual file content

**Source:** `SECURITY.md §6`

**Problem:**
When a user uploads a file, the API checks the _declared_ MIME type from the
request. But it never inspects the actual bytes. A client can declare
`Content-Type: image/png` and upload a PHP script, HTML, or SVG with embedded
scripts. S3 stores it with the wrong content type and serves it to other users.

**Impact:** Stored XSS or malware distribution through the CDN/S3 presigned URLs.

**Fix plan:**

1. After `POST /assets/:id/confirm`, download the first 8KB of the object from S3
2. Use `file-type` npm package to detect the real MIME from magic bytes
3. If it does not match the declared type, delete the object and return 422
4. For images, also run through `sharp` to verify it can be decoded (strips
   malicious metadata)
5. Update `SECURITY.md §6` gap status

**Effort:** ~4 hours

---

### SEC-06 — Refresh token family revocation is absent

**Source:** `SECURITY.md §3`

**Problem:**
Refresh tokens are single-use (a used token is revoked and a new one issued).
But if a token is stolen and used by an attacker _before_ the real user uses it,
the real user's next request uses a revoked token and gets a 401 — but the
attacker's session stays alive. There is no detection that a token was used twice
which would indicate theft and trigger revocation of _all_ sessions.

**Impact:** A stolen refresh token gives an attacker a persistent session that
cannot be detected without the user noticing and manually logging out all devices.

**Fix plan:**

1. Add a `family_id` (UUID) to `refresh_sessions` — set at creation, inherited
   on rotation
2. On rotation: before issuing new token, check if the presented token's row is
   already revoked. If revoked and a newer row exists in same family → token reuse
   detected → revoke entire family
3. Add `POST /auth/logout-all` to let users manually clear all sessions
4. Log a `REFRESH_TOKEN_REUSE` security event when reuse is detected

**Effort:** ~4 hours

---

## 🟡 Medium — fix before production scale

---

### SEC-07 — No Content Security Policy on the Next.js frontend

**Source:** `SECURITY.md §5`

**Problem:**
The NestJS API has Helmet for security headers. The Next.js app has no CSP,
no `Referrer-Policy`, and no `X-Frame-Options`. This means any XSS vulnerability
in the frontend has no secondary mitigation.

**Fix plan:**

1. Add `next.config.ts` headers configuration:
   ```ts
   headers: [
     {
       source: '/(.*)',
       headers: [
         { key: 'X-Frame-Options', value: 'DENY' },
         { key: 'X-Content-Type-Options', value: 'nosniff' },
         { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
         { key: 'Content-Security-Policy', value: "default-src 'self'; ..." },
       ],
     },
   ];
   ```
2. The CSP needs to allow the API origin, S3 presigned URL origins, and
   Next.js inline scripts (use nonce-based CSP for those)

**Effort:** ~2 hours

---

### SEC-08 — Base container images are not digest-pinned

**Source:** `SECURITY.md §13`

**Problem:**
`infra/docker/node-app.Dockerfile` uses `node:22-alpine` (floating tag).
The observability stack uses `latest` tags. A supply-chain attack that poisons
the `node:22-alpine` image would silently compromise all deployments.

**Fix plan:**

1. Pin all base images to their digest:
   ```dockerfile
   FROM node:22-alpine@sha256:<digest>
   ```
2. Add Renovate or Dependabot to auto-update pinned digests
3. Set up a weekly GitHub Actions job to check for new digests

**Effort:** ~1 hour to pin, ~2 hours for automation

---

### SEC-09 — No automated dependency update automation

**Source:** `SECURITY.md §13`

**Problem:**
There is no Dependabot or Renovate config. Dependency updates are manual.
`pnpm audit` runs in CI but only catches known vulnerabilities — it does not
update packages.

**Fix plan:**

1. Add `.github/dependabot.yml`:
   ```yaml
   version: 2
   updates:
     - package-ecosystem: npm
       directory: /
       schedule:
         interval: weekly
       groups:
         patch-updates:
           update-types: ['patch']
   ```
2. Or use Renovate with auto-merge for patch updates

**Effort:** ~30 minutes

---

### SEC-10 — Bull Board bypasses NestJS guard pipeline

**Source:** `SECURITY.md §5`

**Problem:**
Bull Board is mounted outside NestJS's guard pipeline with its own Express
middleware. The middleware checks for a valid ADMIN access token, but this
is a manual check that does not benefit from NestJS guards, interceptors,
or audit logging.

**Impact:** Any future change to the auth system may not be reflected in
Bull Board's protection. No audit log when an admin views job payloads.

**Fix plan:**

1. Add an audit log write when Bull Board is accessed
2. Add `BULL_BOARD_ENABLED=false` as a hard requirement in the production
   deployment checklist — it exposes all tenant job payloads
3. Document clearly in `SECURITY.md` that it must never be on for regular users

**Effort:** ~1 hour

---

## 🟢 Low — operational hardening

---

### SEC-11 — No WAF or DDoS protection

**Source:** `SECURITY.md §15`, `OPERATIONS.md §11`

**Problem:** No Web Application Firewall or volumetric DDoS protection exists
in the repository.

**Fix plan:** Use the hosting provider's edge protection:

- Vercel (web): already has DDoS protection at the edge
- Railway/Render (API): put Cloudflare free tier in front of the API origin
- Set `TRUST_PROXY` to Cloudflare IP ranges

**Effort:** ~1 hour setup

---

### SEC-12 — No external penetration test

**Source:** `SECURITY.md §14`

**Problem:** No external security audit has been performed. Unknown
vulnerabilities may exist, especially around the credit engine and social
token handling.

**Fix plan:** Before handling real customer money or social tokens,
commission a penetration test. For the demo/portfolio phase:

1. Run OWASP ZAP against the demo deployment
2. Run `npm audit` and `snyk test` in CI
3. Document the scope and findings

**Effort:** Variable

---

## Summary table

| ID     | Title                              | Severity    | Effort   |
| ------ | ---------------------------------- | ----------- | -------- |
| SEC-01 | No readiness probes                | 🔴 Critical | 2h       |
| SEC-02 | In-process rate limiter            | 🔴 Critical | 3h       |
| SEC-03 | X-Forwarded-For spoofing           | 🔴 Critical | 1h       |
| SEC-04 | No email provider                  | 🔴 Critical | 3h       |
| SEC-05 | Upload MIME not verified           | 🔴 Critical | 4h       |
| SEC-06 | No refresh token family revocation | 🔴 Critical | 4h       |
| SEC-07 | No CSP on frontend                 | 🟡 Medium   | 2h       |
| SEC-08 | Unpinned container images          | 🟡 Medium   | 1h       |
| SEC-09 | No dependency automation           | 🟡 Medium   | 0.5h     |
| SEC-10 | Bull Board outside guard pipeline  | 🟡 Medium   | 1h       |
| SEC-11 | No WAF/DDoS protection             | 🟢 Low      | 1h       |
| SEC-12 | No external pentest                | 🟢 Low      | Variable |
