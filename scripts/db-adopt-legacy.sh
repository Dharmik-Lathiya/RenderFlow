#!/usr/bin/env bash
# Adopts an existing pre-Drizzle (Prisma-era) database into Drizzle's migration
# history.
#
# WHY THIS IS NEEDED
# ------------------
# The Prisma schema and the Drizzle schema are not schema-compatible: Prisma's
# client generated id and updated_at values in application code and left those
# columns with no database default, while Drizzle relies on `gen_random_uuid()`
# and `now()`. So a database created under Prisma cannot simply be pointed at by
# `drizzle-kit migrate` - it would try to CREATE TABLE over tables that already
# exist and fail on the first statement.
#
# The fix is to record migration 0000 as already applied (it describes exactly
# what Prisma built), then let Drizzle apply everything after it. Migration 0004
# then adds the column defaults that were missing. Both steps are idempotent.
#
# USAGE
# -----
#   scripts/db-adopt-legacy.sh <database-url>
#
# This is destructive-adjacent and MUST be run against a backup. It refuses to
# run unless the database looks like a pre-Drizzle one, and refuses if it is
# empty, because "already migrated" and "not migrated" need different responses.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <database-url>" >&2
  exit 2
fi

DATABASE_URL_ARG="$1"
export DATABASE_URL="$DATABASE_URL_ARG"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_DIR="$REPO_ROOT/libs/db"
MIGRATIONS_DIR="$DB_DIR/drizzle"
BASELINE_SQL="$MIGRATIONS_DIR/0000_loose_red_hulk.sql"

log() { printf '[adopt] %s\n' "$1"; }
die() { printf '[adopt] ERROR: %s\n' "$1" >&2; exit 1; }

psql_q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "$1"; }

[ -f "$BASELINE_SQL" ] || die "baseline migration not found at $BASELINE_SQL"

# --- 1. sanity checks -------------------------------------------------------

if [ "$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")" -lt 1 ]; then
  die "the database has no tables. For an empty database just run 'pnpm db:migrate' - there is nothing to adopt."
fi

if psql_q "SELECT to_regclass('public.__drizzle_migrations') IS NOT NULL OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL" | grep -q t; then
  die "this database already has Drizzle migration history. Run 'pnpm db:migrate' instead; adopting it again would corrupt the history."
fi

for table in users wallets credit_ledger refresh_sessions; do
  psql_q "SELECT to_regclass('public.$table') IS NOT NULL" | grep -q t \
    || die "expected table '$table' (pre-Drizzle schema) but it is missing. This does not look like a database to adopt."
done

# --- 2. record the baseline as applied -------------------------------------

# Drizzle records (created_at, hash) where hash is the sha256 of the migration
# file and created_at is the journal's `when` value in milliseconds. Both are
# read from the journal rather than hardcoded, so this keeps working if the
# migration is ever regenerated.
read -r BASELINE_WHEN BASELINE_HASH < <(
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const journal = JSON.parse(readFileSync(process.argv[1] + "/drizzle/meta/_journal.json", "utf8"));
    const entry = journal.entries.find((e) => e.tag === "0000_loose_red_hulk");
    if (entry === undefined) { throw new Error("journal has no 0000 entry"); }
    const sql = readFileSync(process.argv[1] + "/drizzle/" + entry.tag + ".sql", "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    console.log(entry.when, hash);
  ' "$DB_DIR"
)

log "recording baseline 0000 as applied (when=$BASELINE_WHEN)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  created_at BIGINT,
  hash TEXT NOT NULL
);
INSERT INTO drizzle.__drizzle_migrations (created_at, hash)
VALUES ($BASELINE_WHEN, '$BASELINE_HASH');
SQL

# --- 3. apply everything after the baseline --------------------------------

log "applying migrations 0001+ (includes 0004, which adds the missing column defaults)"

cd "$DB_DIR"
DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/drizzle-kit migrate

log "done. Verify with: psql '$DATABASE_URL' -c '\\d users'"