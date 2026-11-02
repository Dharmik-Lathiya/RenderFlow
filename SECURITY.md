# Security

RenderFlow stores credentials, moves paid credits and publishes to external
social accounts. This document describes the security controls that exist in the
repository, the threat model they address, and the gaps an operator must close
before exposing the system to real users.

It is not a compliance certification. No penetration test, external audit or
live-provider security review has been performed.

**Verified against:** repository at 2026-11-01.

## 1. Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private vulnerability reporting channel if it is enabled, or contact the
maintainers through the private channel used to grant repository access. Include:

- affected route or component,
- reproduction steps,
- impact (data exposure, credit movement, account takeover, denial of service),
- whether the issue is already public.

There is no bug bounty and no guaranteed response SLA. The maintainers should
acknowledge a report, agree a disclosure timeline, and credit the reporter unless
asked otherwise.

## 2. Assets and threat model

| Asset                             | Why it matters                                                      |
| --------------------------------- | ------------------------------------------------------------------- |
| User passwords and sessions       | Account takeover; reuse on other sites.                             |
| Wallet and ledger                 | Real money; a wrong balance is a financial loss.                    |
| Social access/refresh tokens      | Ability to post as a customer.                                      |
| Brand, campaign and post content  | Confidential business material and potentially personal data.       |
| Uploaded and generated media      | Private customer assets; may contain people or unreleased products. |
| `TOKEN_ENCRYPTION_KEY`            | Decrypts every stored social token.                                 |
| `JWT_ACCESS_SECRET` / refresh key | Forgery or impersonation if leaked.                                 |
| Database and object-storage dumps | Contain password hashes, encrypted tokens and all tenant data.      |
| Operator credentials              | Cross-tenant reads, credit adjustments and job replay.              |

The main threats considered:

- credential stuffing and password brute force,
- session theft and CSRF against cookie-authenticated routes,
- cross-tenant access through a guessed or substituted ID,
- credit manipulation, double charge or double refund,
- duplicate social posts after a retry,
- SSRF through a future user-supplied URL feature,
- prompt injection through brand or post text,
- secret leakage through logs, error bodies or client bundles,
- supply-chain compromise of a dependency or container image.

## 3. Authentication

### Passwords

- Argon2id with OWASP minimum parameters (`m=19456 KiB`, `t=2`, `p=1`).
- Minimum length 10 characters, maximum 200.
- Passwords are never logged. Login runs a dummy hash when the address is
  unknown, so response timing does not reveal whether an account exists.
- Password reset burns the one-shot token before writing the new password and
  revokes every existing refresh session in the same transaction.

### Sessions

| Credential    | Storage                      | Lifetime | Flags                                              |
| ------------- | ---------------------------- | -------- | -------------------------------------------------- |
| Access token  | `rf_access` cookie or bearer | 15m      | `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| Refresh token | `rf_refresh` cookie          | 7d       | `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| CSRF token    | `rf_csrf` cookie             | 15m      | readable by JavaScript by design                   |

- Access tokens are signed JWTs and carry the user id and global role.
- Refresh tokens are random secrets; only a hash is stored in
  `refresh_sessions`.
- Refresh rotates the token: the presented row is revoked and a new session is
  issued. A replayed revoked token is rejected. There is no token-family reuse
  detection that revokes every session on suspected theft.
- Logout revokes the presented refresh session. A password reset revokes all
  sessions.
- Bearer authentication is supported for non-browser clients. A header takes
  precedence over a cookie.

### Email verification and recovery

Reset and verification links use one-shot, expiring tokens stored as digests.
`POST /auth/forgot-password` always returns `202` whether or not the address is
registered, so it is not an account-existence oracle. Registration does report
that an email is already registered.

Production refuses `EMAIL_PROVIDER=log` because that transport writes the
one-shot reset link into the log stream, turning log access into account
takeover. The only implemented production-safe value today is `none`, which sends
nothing. **A real email provider must be implemented before password reset or
email verification can work in production.**

## 4. Authorization and tenancy

The API is deny-by-default. Every route requires authentication unless it is
explicitly marked `@Public()`. Global guards run in this order:

1. pre-authentication rate limit,
2. CSRF,
3. authentication,
4. post-authentication rate limit,
5. role check.

Authorization has two layers:

- **Global role** (`ADMIN` or `MEMBER`) gates operator routes and Bull Board.
- **Workspace role** (`OWNER`, `EDITOR`, `APPROVER`, `VIEWER`) gates studio and
  publishing actions.

Workspace access is resolved in the service layer, not by trusting a body or
query parameter. A caller cannot read or mutate a brand, campaign, post, asset,
social account or publish job from another workspace by substituting its id. The
operator surface is also scoped: a global `ADMIN` sees every workspace, while a
workspace `OWNER` only sees the workspaces they own. List queries filter in SQL,
and every mutation re-checks the same scope.

Integration tests cover multi-tenant isolation for workspace-scoped endpoints.
New endpoints are expected to add the same coverage.

## 5. Browser protections

### CSRF

Cookie-authenticated unsafe methods require a double-submit token:

- the browser reads the non-`HttpOnly` `rf_csrf` cookie,
- it sends the same value in `x-csrf-token`,
- the API compares the two in constant time.

Bearer-authenticated requests are exempt because no ambient cookie is present.
Login, registration, forgot-password, reset-password and verify-email are exempt
because the caller has no session yet; those routes are rate limited and tokens
are single-use.

### CORS

`CORS_ORIGINS` must be an explicit comma-separated allow-list. A wildcard is a
boot failure because it is incompatible with credentialed cookie requests.
`credentials: true` is enabled, and only the configured origins are allowed.

### Cookies and same-site deployment

The auth cookies are `SameSite=Lax`. Deploy the web app and API on the same
registrable site (for example `app.example.com` and `api.example.com`). A
cross-site API deployment would require a deliberate cookie-policy change and a
CSRF review. Do not set `SameSite=None` casually.

### Headers

Helmet sets `X-Content-Type-Options`, `X-Frame-Options`, HSTS, referrer policy
and related headers on API responses. CSP is disabled because the API itself
returns JSON and the only HTML it can serve is Swagger UI (development-only) and
Bull Board (opt-in).

The Next.js app sets a nonce-based `Content-Security-Policy` in `proxy.ts` plus
`Referrer-Policy`, `Permissions-Policy` and a frame policy on every response.
Nonce CSP requires dynamic rendering: if a page were statically prerendered its
scripts would carry no nonce and the browser would block them, so the root layout
reads the nonce and opts every page into dynamic rendering.

Swagger UI is not mounted in production. The raw OpenAPI document remains
available at `/docs-json`; treat it as public API metadata, not a secret.

### Bull Board

Bull Board is disabled by default (`BULL_BOARD_ENABLED=false`). When enabled it
is mounted outside Nest's guard pipeline, so it carries its own authentication
middleware: a valid access token with the global `ADMIN` role. It exposes every
tenant's job payloads and must not be enabled for ordinary workspace owners.

Every non-static board request writes an `audit_logs` row (`queue_board.access`)
with the operator, method and path. If that write fails the request is refused
with 503: an unauditable access to cross-tenant job data is the failure the
control exists to prevent. Static assets are not audited.

## 6. Input validation and uploads

- HTTP bodies, query parameters and queue payloads are validated with zod or
  Nest pipes before use.
- LLM output is requested as structured JSON and validated with zod. A validation
  failure is retried once with a repair prompt, then classified `PERMANENT`.
- Uploads accept only `image/png`, `image/jpeg`, `image/webp`, `video/mp4`,
  `audio/mpeg`, `audio/wav` and `application/pdf`.
- Maximum upload size is 25 MiB.
- Uploads use a presigned PUT valid for 15 minutes. The object key is derived
  from server-generated IDs, so a client cannot choose a key or overwrite another
  tenant's object.
- Confirmation calls `headObject` and records the real size; the client's
  declared size is not trusted.
- Downloads use a presigned GET valid for 5 minutes, issued only after a
  workspace access check.

**Gap:** the declared MIME type is checked, but the stored object's actual
content type is not sniffed or re-encoded. A client can declare `image/png` and
upload other bytes that S3 accepts. Add content inspection or transcoding before
serving user uploads to other users at scale.

## 7. SSRF

No current feature fetches a user-supplied URL. The only outbound HTTP calls are
to configured providers, storage and social APIs. SSRF hardening is therefore not
implemented rather than silently missing.

If a feature adds URL fetching or link previews, it must:

- allow only `http` and `https`,
- resolve DNS and reject loopback, link-local, private, multicast and metadata
  addresses,
- re-check after redirects and cap redirect depth,
- apply connect and total timeouts,
- never forward internal credentials or headers.

Until then, do not accept arbitrary URLs from users.

## 8. Secrets and encryption

| Secret                  | Requirement                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`     | at least 32 characters; no fallback; API refuses to boot if weak. |
| `JWT_REFRESH_SECRET`    | at least 32 characters; no fallback.                              |
| `TOKEN_ENCRYPTION_KEY`  | base64 of exactly 32 bytes; AES-256-GCM key for social tokens.    |
| Provider API keys       | environment only; never in client bundles or the repository.      |
| Database/S3 credentials | environment or workload identity; least privilege.                |

Social access and refresh tokens are encrypted as one AES-256-GCM envelope with a
fresh 96-bit IV per write and a versioned format (`v1.<iv>.<tag>.<ciphertext>`).
The API never returns token values. Rotating `TOKEN_ENCRYPTION_KEY` makes existing
tokens unreadable; plan a reconnect campaign or a re-encryption migration.

Production refuses two dangerous development modes at boot:

- `EMAIL_PROVIDER=log` (would log one-shot reset links),
- `BILLING_PROVIDER=stub` (would mint credits without payment).

`.env` is git-ignored. Keep `.env.example` current and never commit real values.

## 9. Data protection

- Passwords are stored as Argon2id hashes, never reversibly.
- Refresh tokens and one-shot auth tokens are stored as hashes.
- Social tokens are encrypted at the application layer.
- Database and object-storage encryption at rest are infrastructure concerns and
  are **not configured by this repository**. Enable provider-managed encryption
  and restrict key access.
- TLS termination is an infrastructure concern. The API sets HSTS; it must be
  served over HTTPS in production.
- Backups contain password hashes, encrypted tokens and all tenant data. Encrypt
  dumps at rest, restrict access, and delete them after the drill. See
  [`docs/backup-restore.md`](./docs/backup-restore.md).

## 10. Logging and error handling

The shared pino logger redacts common secret field names at the top level and
walks nested objects to redact them at any depth. Redacted names include
passwords, tokens, authorization headers, cookies, API keys, secret keys and
external post ids.

Rules for new code:

- never log request bodies wholesale,
- never log prompts that contain personal data,
- include `requestId`, `userId`, `jobId` and `stage` where applicable, not raw
  payloads,
- never echo a token or password in an error response,
- keep stable error codes and generic messages for authentication failures.

The global exception filter returns `{ code, message, details }`. It must not
include stack traces or secrets in production responses.

## 11. Rate limiting

Rate limits are configuration, parsed at boot. An unparseable value fails startup
rather than silently disabling a control.

| Rule            | Default  | Scope |
| --------------- | -------- | ----- |
| Login           | `10/15m` | IP    |
| Login account   | `30/1h`  | Email |
| Register        | `5/1h`   | IP    |
| Refresh         | `60/15m` | IP    |
| Generate        | `30/1h`  | User  |
| Campaign        | `10/1h`  | User  |
| Schedule        | `60/1h`  | User  |
| Admin           | `120/1h` | User  |
| Forgot password | `5/1h`   | IP    |
| Reset password  | `10/1h`  | IP    |
| Verify email    | `20/1h`  | IP    |
| Top-up          | `10/1h`  | User  |

**Limitations:**

- The store is in-process. With N API replicas the effective ceiling is N times
  the configured limit. Add a shared Redis store before horizontal scaling.
- `X-Forwarded-For` is trusted as supplied. Deploy behind a proxy that overwrites
  the header; otherwise a direct client can spoof the IP key.
- The limiter is a denial-of-service brake, not a billing control. Credits and
  provider quotas are the billing controls.

## 12. AI-specific risks

- Brand, campaign and post text is treated as untrusted data in prompts, not as
  instructions. System prompts delimit it.
- Moderation runs in the request path before credits are reserved for generation.
- LLM output is schema-validated; a structured response that fails validation is
  retried once with a repair prompt, then failed as `PERMANENT`.
- Provider fallback stops on a `PERMANENT` refusal, so a fallback cannot route
  around a moderation decision.
- Mock providers are deterministic and local. No real model provider has been
  called, so prompt-injection resistance against a live model is unverified.
- Sending customer content to a third-party model provider creates a data
  processing relationship. Review the provider's retention and training terms
  before enabling a real provider.

## 13. Supply chain and dependencies

- `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
- CI runs `pnpm audit --audit-level high` and fails on high or critical
  advisories.
- `pnpm-workspace.yaml` pins patched transitive versions where a direct upgrade
  was not possible.
- Residual advisories are development-only and have no patched release at the
  time of writing. CI's threshold is high/critical; do not lower it to make a
  build pass.
- Container images are multi-stage, run as the non-root `node` user and exclude
  the TypeScript toolchain and dev dependencies.
- Base images are not digest-pinned, and the observability stack uses floating
  `latest` tags. Pin digests and add automated image updates before a regulated
  deployment.
- There is no Dependabot or Renovate configuration in the repository. Dependency
  updates are manual.

## 14. Infrastructure checklist before launch

- [ ] Serve the API and web app over HTTPS only.
- [ ] Put the API behind a proxy that overwrites `X-Forwarded-For`, and set
      `TRUST_PROXY` to the hop count or proxy CIDR. `TRUST_PROXY=false` is correct
      only when the API is directly reachable; `true` lets any caller spoof the
      header.
- [ ] Set `NODE_ENV=production`, explicit `CORS_ORIGINS`, and secure cookies.
- [ ] Generate unique, high-entropy JWT and token-encryption secrets; store them
      in a secret manager, not in an image or a repository.
- [ ] Enable encryption at rest for PostgreSQL, S3 and backups.
- [ ] Restrict database and S3 credentials to the minimum required.
- [x] Implement a real email provider before enabling password reset: the
      `resend` adapter is wired (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`) and
      refuses to boot without a key; `mailhog` remains local-only.
- [ ] Keep `BULL_BOARD_ENABLED=false` unless an operator genuinely needs it.
- [x] Wire real readiness probes (PostgreSQL, Redis and S3) and keep them
      dependency-backed; `/health/ready` returns 503 when any is down.
- [x] Add a shared rate-limit store before running more than one API replica:
      `RATE_LIMIT_STORE=redis` shares one atomic window; `memory` remains the
      single-replica default.
- [x] Add Alertmanager or another alert delivery path.
- [x] Pin container image digests and enable dependency update automation
      (`.github/dependabot.yml` covers npm, Docker and GitHub Actions).
- [ ] Review provider data-processing terms and configure retention.
- [ ] Run a restore drill and an incident tabletop.
- [ ] Commission an external penetration test before handling real customer data.

## 15. Known gaps

| Gap                                      | Impact                                                                 | Status / next step                                           |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| In-memory rate limiter                   | Effective limits multiply with API replicas.                           | Add Redis-backed store before scaling out.                   |
| Trusted `X-Forwarded-For`                | Rate-limit key spoofing if the API is directly reachable.              | Enforce trusted-proxy deployment.                            |
| No real email provider                   | Password reset and verification cannot work in production.             | Implement and test a provider.                               |
| Mock social adapter only                 | No real OAuth, token refresh or publishing has been verified.          | Implement and test live adapters before enabling publishing. |
| No SSRF protection                       | Becomes critical if URL fetching is added.                             | Implement before that feature ships.                         |
| Upload MIME not re-checked               | Declared type can differ from stored bytes.                            | Add content inspection or transcoding.                       |
| No alert delivery                        | Alert rules evaluate, but no Alertmanager is deployed.                 | Add Alertmanager or an equivalent notification path.         |
| Worker metrics absent                    | Worker health is inferred from the database, not scraped.              | Expose `/metrics` or remove dead scrape targets.             |
| Refresh token reuse detection incomplete | A stolen refresh token is single-use, but family revocation is absent. | Add reuse detection that revokes the session family.         |
| No WAF / DDoS protection in repo         | Volumetric attacks are an infrastructure responsibility.               | Use the hosting provider's edge protection.                  |
| No external security audit               | Unknown unknowns remain.                                               | Commission a penetration test before launch.                 |

## 16. Incident response

1. Preserve evidence: logs, database rows, request ids and provider request ids.
2. Contain: revoke sessions (`logoutAll` path or direct session revocation),
   rotate JWT secrets, disable affected provider keys, or set a specific
   `RATE_LIMIT_<RULE>` value to `0` as a deliberate, temporary measure. Note that
   `RATE_LIMIT_ENABLED` switches off every rule at once and is for load tests,
   not incident response.
3. Assess credit impact with `GET /api/v1/admin/reconcile`; do not hand-edit
   wallets.
4. Assess social impact: check `publish_jobs.external_post_id` before retrying
   anything, and notify affected workspace owners.
5. Recover from a known-good backup if data integrity is in doubt, following
   [`docs/backup-restore.md`](./docs/backup-restore.md).
6. Write a post-incident review with timeline, root cause, customer impact and
   follow-up owners.

For day-to-day operational procedures, see [`OPERATIONS.md`](./OPERATIONS.md).
