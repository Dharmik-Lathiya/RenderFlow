# Backup and restore runbook

Phase 10 asks for a backup/restore document and a drill. This is that runbook.
It describes what to back up, how to prove a restore works, and the order to do
it in without double-publishing a post or charging a credit twice.

**The repository does not schedule production backups.** Postgres and object
storage are infrastructure; the operator of that infrastructure owns the
schedule and retention. What is in this repository is the drill
(`scripts/backup-restore-check.sh`) that proves a dump can be restored, and the
procedure below for doing it safely.

## Targets

| Property             | Target                         | Why                                                    |
| -------------------- | ------------------------------ | ------------------------------------------------------ |
| Recovery point (RPO) | 15 minutes                     | A lost generation is cheap; a lost ledger row is not.  |
| Recovery time (RTO)  | 1 hour                         | Restore, verify, then let the outbox relay drain.      |
| Drill frequency      | Quarterly, and before a launch | An untested backup is a hypothesis, not a backup.      |
| Retention            | 30 daily, 12 monthly           | Enough to investigate a billing dispute a month later. |

If the managed Postgres offers point-in-time recovery (WAL archiving), use it:
it is the only way to hit a 15-minute RPO. The `pg_dump` procedure below is the
portable fallback and the restore drill, not a substitute for PITR.

## What to back up

1. **Postgres** — the source of truth. Users, wallets, the append-only
   `credit_ledger`, jobs, checkpoints, posts, schedules, outbox events and audit
   logs all live here. `pg_dump --format=custom` is the portable format.
2. **Object storage (S3/MinIO)** — generated images, audio and reels. Back up the
   bucket or enable versioning. The database stores the storage key, not the
   bytes; a restored row pointing at a missing object is a broken post.
3. **Configuration and secrets** — the environment variables in `.env.example`
   and the deployment platform's secret store. Do not put them in the database
   dump or in git. Losing `TOKEN_ENCRYPTION_KEY` makes every stored social token
   undecryptable; losing `JWT_*` signs everyone out (recoverable, unlike the
   token key).
4. **Not Redis.** Queues are transport, not state. The outbox in Postgres is the
   durable record of work to publish. After a restore, flush Redis and let the
   relay republish pending outbox events. Keeping a Redis snapshot from a later
   point than the database is how a job runs against a row that no longer exists.

## The drill

The script dumps a source database, restores it into an **already-created empty
scratch database**, compares a content hash for every table, checks the credit
invariants and confirms the five unique indexes that provide idempotency are
present.

```bash
createdb renderflow_restore

DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow \
RESTORE_DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow_restore \
  ./scripts/backup-restore-check.sh
```

The script refuses to run when both URLs are the same. It deletes its dump on
exit. The dump still contains password hashes and encrypted social tokens, so
run the drill on a trusted machine and never attach the dump to a ticket.

Use a role that can create extensions (the local compose user is a superuser, as
is the CI Postgres service user), or pre-install `vector` in the scratch
database. `pg_restore --clean` drops and recreates the extension along with the
rest of the schema.

Expected output:

```
== dumping the source
...
== restoring into the scratch database
== comparing every table
PASS: 20 tables match, and the credit invariants hold
```

The table count grows with new migrations; the PASS line is the assertion, not
the number.

## Restoring production

Do these in order. Steps 1 and 2 are what prevent a restored job from publishing
twice.

1. **Stop the writers.** Scale `apps/api`, all workers, `outbox-relay` and
   `reaper` to zero. Leave the database up. A running worker can heartbeat a
   lease or publish while you are swapping the database underneath it.
2. **Flush Redis.** `redis-cli FLUSHDB` on the application database. Any queued
   job belongs to the old timeline; the outbox replay after the restore is the
   only correct source of work.
3. **Take a safety dump of the current database**, even if it is the broken one.
   It is the only way back if the restore makes things worse.
4. **Restore into a new database first** and run the drill against it. Do not
   restore over the live database in place. `pg_restore --clean --if-exists`
   drops objects; a failure halfway leaves a half-restored production database.
5. **Point the application at the restored database** (connection string/secret),
   then start `apps/api` and check `GET /health/ready`.
6. **Start the outbox relay and workers.** Watch `GET /admin/dlq` and the queue
   depth. Pending `outbox_events` are republished; `reaper` requeues jobs whose
   leases expired. Confirm no job is charged twice by checking `GET /admin/reconcile`
   returns zero drift for the affected users.
7. **Reconcile object storage.** Compare `assets.storage_key` against the bucket;
   restore any missing object from the storage backup before a post referencing
   it is published.
8. **Record the drill.** Date, dump size, restore duration, table count, any
   mismatch. If the restore took longer than the RTO, the target is wrong or the
   procedure needs work.

### Point-in-time recovery

With a managed provider, create a new instance at the target timestamp, then
follow steps 1, 2, 4 (drill against the new instance) and 5–7. Never rewind the
primary in place: the WAL after the target is gone, and an in-place rewind hides
that fact.

### Object storage

Enable bucket versioning or run a daily `mc mirror`/`aws s3 sync` to a separate
bucket. A database restore and an object restore must be from compatible points
in time; a row from 10:00 with an object overwritten at 10:05 is still readable,
but an object deleted at 10:05 is not.

## Verification checklist

- [ ] `scripts/backup-restore-check.sh` prints PASS against the new database.
- [ ] `GET /health/ready` is green.
- [ ] `GET /admin/reconcile` reports zero drift.
- [ ] `GET /admin/dlq` shows no new permanent failures after the queue drains.
- [ ] A test post renders its poster/reel from the restored bucket.
- [ ] The restored `credit_ledger` row count matches the source dump's count.
- [ ] The dump and the drill database are deleted.

## Local verification

Run on 2026-10-29 against the development database:

```
PASS: 20 tables match, and the credit invariants hold
```

That run restored every table, not a sample, and re-checked that
`credit_ledger_reference_key`, `credit_ledger_signup_bonus_once`,
`generation_jobs_user_idempotency_key`, `publish_jobs_idempotency_key` and
`outbox_events_dedupe_idx` survived the round trip.
