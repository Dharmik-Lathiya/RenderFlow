#!/usr/bin/env bash
#
# Backup/restore drill (PROJECT.md Phase 10).
#
# Dumps a source database in Postgres's custom format, restores it into an
# already-created scratch database, and then proves the copy is identical by
# comparing a content hash for every table. It refuses to touch the source and
# refuses to run when the two URLs point at the same database.
#
# Usage:
#   createdb renderflow_restore
#   DATABASE_URL=... RESTORE_DATABASE_URL=... ./scripts/backup-restore-check.sh
#
# The dump contains encrypted social tokens and password hashes. Treat it as
# production data: encrypt it at rest and delete it when the drill is over. This
# script keeps it in a private temporary directory and removes it on exit.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (the source database)}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required (an empty scratch database)}"

if [[ "$DATABASE_URL" == "$RESTORE_DATABASE_URL" ]]; then
  echo "refusing to restore a database over itself" >&2
  exit 2
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
dump="$workdir/renderflow.dump"

echo "== dumping the source"
pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$DATABASE_URL"
ls -lh "$dump"

echo "== restoring into the scratch database"
# --clean drops the objects pg_restore is about to recreate, so a previous drill
# can be repeated without recreating the database by hand. --exit-on-error is
# what makes a partial restore a failure instead of a warning.
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname="$RESTORE_DATABASE_URL" \
  "$dump"

echo "== comparing every table"

# The migration journal is included on purpose: a restore that loses it would
# make the next `db:migrate` re-apply history that is already there.
tables=$(psql "$DATABASE_URL" -Atc \
  "select quote_ident(tablename) from pg_tables where schemaname = 'public' order by tablename")

mismatches=0
checked=0

while IFS= read -r table; do
  [[ -z "$table" ]] && continue

  # A content hash, not just a row count: a restore that swaps two rows has the
  # same count and would pass a weaker check. The ORDER BY makes it stable.
  # The aggregate holds the table's row text in memory, which is fine for the
  # test-sized databases this drill runs against; hash a sample for a
  # multi-gigabyte table.
  query="select md5(coalesce(string_agg(row_to_json(t)::text, '|' order by row_to_json(t)::text), '')) from $table t"

  source_hash=$(psql "$DATABASE_URL" -Atc "$query")
  restore_hash=$(psql "$RESTORE_DATABASE_URL" -Atc "$query")
  checked=$((checked + 1))

  if [[ "$source_hash" != "$restore_hash" ]]; then
    echo "MISMATCH $table (source $source_hash, restore $restore_hash)" >&2
    mismatches=$((mismatches + 1))
  fi
done <<<"$tables"

# The invariants below are cheap and catch a dump taken while a credit
# transaction was in flight, which a table hash cannot distinguish from a
# faithful copy of a broken source.
negative_wallets=$(psql "$RESTORE_DATABASE_URL" -Atc \
  'select count(*) from wallets where available < 0 or reserved < 0')
duplicate_claims=$(psql "$RESTORE_DATABASE_URL" -Atc \
  "select count(*) from (
     select reference_type, reference_id, entry_type
     from credit_ledger
     where reference_type is not null and reference_id is not null
     group by 1, 2, 3
     having count(*) > 1
   ) duplicates")

if [[ "$negative_wallets" != "0" || "$duplicate_claims" != "0" ]]; then
  echo "credit invariants failed after restore: negative wallets=$negative_wallets, duplicate claims=$duplicate_claims" >&2
  mismatches=$((mismatches + 1))
fi

# The unique indexes are the idempotency guarantee, not an optimisation. A
# restore that silently omitted one would still have every row, so check they
# came back by name.
critical_indexes=$(psql "$RESTORE_DATABASE_URL" -Atc \
  "select count(*) from pg_indexes
   where schemaname = 'public'
     and indexname in (
       'credit_ledger_reference_key',
       'credit_ledger_signup_bonus_once',
       'generation_jobs_user_idempotency_key',
       'publish_jobs_idempotency_key',
       'outbox_events_dedupe_idx'
     )")

if [[ "$critical_indexes" != "5" ]]; then
  echo "expected 5 critical unique indexes after restore, found $critical_indexes" >&2
  mismatches=$((mismatches + 1))
fi

if [[ "$mismatches" -ne 0 ]]; then
  echo "FAIL: $mismatches checks failed across $checked tables" >&2
  exit 1
fi

echo "PASS: $checked tables match, and the credit invariants hold"
