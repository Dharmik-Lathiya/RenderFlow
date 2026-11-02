# Backup and restore runbook

Phase 10 asks for a backup/restore document and a drill. This is that runbook.
It describes what to back up, how to prove a restore works, and the order to do
it in without double-publishing a post or charging a credit twice.

**The demo deployment uses Neon's automatic backups.** Neon takes continuous
backups and offers point-in-time restore on its paid plans; enabling PITR is a
project setting, not code. For a self-hosted Postgres (or an independent copy
outside the database provider), `scripts/backup-to-s3.sh` takes a daily
`pg_dump`, verifies the archive, uploads it with a SHA-256 sidecar, and prunes
old objects. The drill (`scripts/backup-restore-check.sh`) is what proves either
kind of backup can actually be restored.

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

## Scheduled backups

### Option A — Neon (recommended for the demo)

1. Create the project on a Neon plan that includes point-in-time restore.
2. Enable **Point-in-time restore** in the project settings and note the
   retention window (7 days on the Launch plan; check the current plan).
3. Set the API's `DATABASE_URL` to the **pooled** connection string and the
   migration/backup job's to the **direct** connection string.
4. Once a quarter, restore a branch at an arbitrary timestamp and run
   `scripts/backup-restore-check.sh` against it. A provider setting is not a
   tested restore.

Neon's restore creates a new branch; it does not rewind the primary. Follow
"Restoring production" below to cut over.

### Option B — self-hosted `pg_dump` to S3

`scripts/backup-to-s3.sh` is the portable option. It needs `pg_dump`,
`pg_restore`, `gzip`, `sha256sum` and the AWS CLI on the runner.

| Variable                | Required | Meaning                                              |
| ----------------------- | -------- | ---------------------------------------------------- |
| `DATABASE_URL`          | yes      | Source database (a read-only role is enough).        |
| `BACKUP_S3_URL`         | yes      | Destination prefix, e.g. `s3://rf-backups/postgres`. |
| `BACKUP_RETENTION_DAYS` | no       | Days to keep; default `7`.                           |
| `AWS_*`                 | no       | Standard AWS CLI credentials/region.                 |
| `AWS_ENDPOINT_URL`      | no       | Set for R2/MinIO instead of AWS S3.                  |

The script:

1. writes a custom-format `pg_dump` to a mode-700 temporary directory;
2. runs `pg_restore --list` to reject a truncated archive **before** upload;
3. uploads `renderflow-<timestamp>.dump.gz` and a `.sha256` sidecar;
4. deletes objects older than the retention window.

Run it daily from a scheduler. On Railway, create a cron service from the same
image with schedule `0 2 * * *` and start command
`./scripts/backup-to-s3.sh`; on Kubernetes, a `CronJob` with the same command.
Keep the bucket private: the dump contains password hashes and encrypted social
tokens.

```bash
DATABASE_URL=... BACKUP_S3_URL=s3://rf-backups/postgres \
AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com \
  ./scripts/backup-to-s3.sh

# Prove the newest object is intact after a restore:
aws s3 cp s3://rf-backups/postgres/renderflow-<timestamp>.dump.gz .
sha256sum -c renderflow-<timestamp>.dump.gz.sha256
```

Never treat "the cron ran" as the check. Alert on a missing object for the
current day, and run the restore drill quarterly.

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

Each table is hashed in one aggregate. That is exact and cheap at the sizes this
repository runs; on a multi-gigabyte table, hash a sample or compare the managed
provider's block checksums instead, because the aggregate has to hold the
table's row text in memory.

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
