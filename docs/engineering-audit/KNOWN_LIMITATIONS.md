# Known Limitations — RenderFlow

> Honest list of what is missing, unverified, or only partially working.
> Updated 2026-11-20. Status labels match `MASTER_AUDIT.md`.

## Production blockers

1. **No real social publish adapter (AUD-02).** The publisher worker now refuses
   to boot in production rather than falsely reporting publication, but no post
   can actually be published to LinkedIn, Instagram, Facebook, or WhatsApp.
2. **No OAuth authorization-code flow (AUD-04).** `POST /social-accounts` accepts
   a caller-supplied token. It is encrypted at rest and never returned, but the
   connection path is not suitable for real users.
3. **Real providers never verified (AUD-05).** No real OpenAI/Anthropic/Replicate/
   ElevenLabs, Resend/SMTP, S3, Instagram Graph, or billing credentials were
   available. Interfaces and mock adapters are tested; live request/response
   handling is not.
4. **Self-approval by OWNER (AUD-22).** Posts do not record a creator. An OWNER
   can create and approve the same post.
5. **Content→media handoff can stall (AUD-23).** Completed-stage routing can
   return `HANDED_OFF` after `SCRIPT` without queueing the `IMAGE` stage.
6. **Publisher lease ownership after claim (AUD-24).** Several post-claim writes
   are not guarded by `worker_id`, allowing a stale worker to overwrite a newer
   worker's lease or terminal status.
7. **Live deployment has no configured API host.** The pushed login fix is
   present in the live bundle (`relative.invalid` is served), but
   `https://renderflowapp.vercel.app/api/v1/health/live` returns 404. Until
   `API_INTERNAL_URL` is set on the web deployment, the rewritten `/api/v1`
   path has nowhere to go and sign-in still cannot succeed.

## Reliability / correctness gaps

- Heartbeat loss is detected but not propagated into generation work (AUD-09).
- Deterministic BullMQ job IDs may collapse distinct outbox events (AUD-28).
- `credits.refunded` queue-message semantics are not fully pinned by tests (AUD-29).
- A regenerated job id can leave the UI watching stale state (AUD-30); `done`
  reconciliation is not uniform (AUD-31).
- The Generate idempotency key may suppress a legitimate second generation
  (AUD-32); polling/upload aborts are not consistently guarded (AUD-33).
- Jest leaves open handles in unit and integration runs (AUD-08/AUD-40).
- Shutdown drain ordering is unverified (AUD-38).

## Operational / deployment gaps

- Docker daemon is unavailable locally, so `docker compose up --build`, image
  builds, MinIO, Grafana rendering, and alert delivery were not verified. CI
  contains the jobs; this audit did not observe their results.
- The local E2E run used a disposable S3-compatible stub, rate limiting disabled,
  and a reseeded `pricing_rules` table. It proves the browser flow, not the
  production infrastructure.
- `next dev` hydration fails locally because the HMR websocket handshake returns
  `net::ERR_INVALID_HTTP_RESPONSE`; E2E was run against the built standalone web
  server instead.
- Pre-deploy script shell defect (AUD-35), Prometheus Redis scrape target is not
  an exporter (AUD-36), and `METRICS_PORT` collisions require manual per-process
  overrides locally (AUD-37).
- No k6 load results, queue-drain timing, same-minute publish burst test, p95
  latency, or Grafana panel/alert-receiver verification was produced.

## Documentation / configuration gaps

- Documented coverage gates (95% credits/state machines, 80% overall) are not
  actually enforced by the Jest configs (AUD-06).
- Several direct `process.env` reads bypass the validated config boundary
  (AUD-11/AUD-26).
- `JWT_REFRESH_SECRET` is required but unused (AUD-14/AUD-27).
- `brands.colors` default drift needs a new migration (AUD-12).
- `JobsService.isSettled()` is not scoped in the helper itself (AUD-13/AUD-28 in
  `SECURITY_AUDIT.md`).
- The demo document references `https://api-production.up.railway.app/api/v1`,
  which has not been verified with `/health/ready`.

## What is explicitly _not_ a limitation

- The credit engine's core invariants, guarded transactions, append-only ledger,
  and single-charge behavior are verified by unit, integration, and chaos tests.
- Social tokens are encrypted at rest and omitted from API responses.
- The relative API base URL fix is deployed and no longer throws before `fetch()`.
- The built standalone web app hydrates and completes the full browser journey
  with mock providers and local infrastructure.
