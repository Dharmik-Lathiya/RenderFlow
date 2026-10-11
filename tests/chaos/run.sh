#!/usr/bin/env bash
# Phase 5 chaos test (PROJECT.md section 13.4, tests R1-R5).
#
# Scenarios:
#   A. Database-level recovery. A worker dies holding a lease with partial
#      checkpoints; the reaper reclaims it; another worker resumes from the
#      checkpoints. Runs with Postgres alone.
#   B. A real SIGKILL. A worker process is killed mid-render with no chance to
#      release its lease, and the recovery is observed through the real queue.
#      Requires Redis.
#
# Usage:
#   CHAOS_DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/chaos \
#   ./tests/chaos/run.sh
#
# SIGKILL, not SIGTERM
# --------------------
# SIGTERM is the graceful path and is covered by the drain tests. SIGKILL is the
# one that matters: the process gets no chance to release its lease, close a
# connection or finish a checkpoint. Everything asserted here has to hold anyway,
# because a machine losing power does not send SIGTERM either.
#
# Reporting rules
# ---------------
# A scenario that cannot run is reported as SKIPPED, never as PASSED, and a
# skipped scenario makes the script exit non-zero. A chaos harness that reports
# green for what it did not do is worse than no harness.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAOS_DB="${CHAOS_DATABASE_URL:-${TEST_DATABASE_URL:-}}"
LOG_DIR="$(mktemp -d)"
PASS=0
FAIL=0
SKIP=0

WORKER_PID=""
cleanup() {
  [[ -n "$WORKER_PID" ]] && kill -9 "$WORKER_PID" 2>/dev/null
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'PASS  %-56s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-56s expected=%s actual=%s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  printf 'SKIP  %-56s %s\n' "$1" "$2"
  SKIP=$((SKIP + 1))
}

note() { printf '\n=== %s ===\n' "$1"; }

fatal() {
  printf '\nFATAL: %s\n' "$1" >&2
  exit 2
}

# --- preconditions ----------------------------------------------------------

[[ -n "$CHAOS_DB" ]] || fatal "set CHAOS_DATABASE_URL (a disposable database)"
command -v psql >/dev/null 2>&1 || fatal "psql is not on PATH"
[[ -d "$ROOT/libs/credits/dist" ]] || fatal "build first: pnpm build"

HAVE_REDIS=false
if command -v redis-cli >/dev/null 2>&1 \
  && redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping >/dev/null 2>&1; then
  HAVE_REDIS=true
fi

note "preparing a dedicated chaos database"
# A dedicated database: this test truncates and leaves failed jobs behind, and
# must not touch the one the integration suite uses.
#
# BOTH schemas go. drizzle-kit keeps its applied-migrations bookkeeping in a
# schema of its own, so dropping only `public` leaves it believing every migration
# has already run - and `migrate` then reports success while creating no tables.
psql "$CHAOS_DB" -c 'DROP SCHEMA IF EXISTS public CASCADE;
                      DROP SCHEMA IF EXISTS drizzle CASCADE;
                      CREATE SCHEMA public;' >/dev/null 2>&1 \
  || fatal "cannot reset $CHAOS_DB"

( cd "$ROOT/libs/db" && DATABASE_URL="$CHAOS_DB" node_modules/.bin/drizzle-kit migrate ) \
  >"$LOG_DIR/migrate.log" 2>&1 || { cat "$LOG_DIR/migrate.log"; fatal "migrations failed"; }

( cd "$ROOT/libs/credits" && DATABASE_URL="$CHAOS_DB" node scripts/seed.mjs ) \
  >"$LOG_DIR/seed.log" 2>&1 || { cat "$LOG_DIR/seed.log"; fatal "seed failed"; }

# --- the scenario harness ---------------------------------------------------
#
# One node program drives the database-level scenarios. It lives in this
# directory rather than in tests/integration because it is a *chaos* entry point:
# the same library code, driven by a script an operator can run against a real
# deployment. The assertions themselves live in tests/integration/reliability.spec.ts,
# which is the gate; this is the one you run when something has gone wrong.

# The harness is `recovery-harness.mjs`, next to this script, and is RUN IN PLACE.
# It imports @renderflow/*, which pnpm only links into the `tests` package, so
# node resolves them by walking up from this directory. Copying it to a temp
# directory - the obvious thing to do to keep the repo clean - breaks exactly
# that, and the failure is a bare ERR_MODULE_NOT_FOUND at startup.

note "database-level recovery (R1-R4)"
HARNESS_JSON=""
if HARNESS_JSON=$(DATABASE_URL="$CHAOS_DB" SIGNUP_BONUS_CREDITS=50 \
  node "$(dirname "${BASH_SOURCE[0]}")/recovery-harness.mjs" 2>"$LOG_DIR/harness.log"); then
  while IFS=$'\t' read -r label expected actual; do
    check "$label" "$expected" "$actual"
  done < <(node -e "
    for (const r of $HARNESS_JSON) console.log([r.label, r.expected, r.actual].join('\t'));
  ")
else
  cat "$LOG_DIR/harness.log" >&2
  fatal "the recovery harness failed; see the output above"
fi

# --- B: a real SIGKILL, which needs the real queue --------------------------
#
# Reported as SKIPPED rather than silently omitted. A green run of this script
# that never killed anything would be a lie.

if [[ "$HAVE_REDIS" != true ]]; then
  note "real SIGKILL (needs Redis)"
  skip "R5 worker killed mid-render with SIGKILL" "no Redis at ${REDIS_URL:-redis://localhost:6379}"
  printf '\n  Start Redis with `docker compose up -d redis` to exercise R5.\n'
  printf '  R1-R4 above are the same recovery decisions, driven without a queue.\n'
else
  note "real SIGKILL (R5)"
  printf '  A worker process will be SIGKILLed mid-render and the job recovered.\n'
  # Wired up in a follow-up: it needs the relay and a live worker, and there is
  # no way to verify it here. Refusing to fake a pass is the point.
  skip "R5 worker killed mid-render with SIGKILL" "scenario not yet implemented"
fi

printf '\n======================================\n'
printf 'PASS: %s   FAIL: %s   SKIP: %s\n' "$PASS" "$FAIL" "$SKIP"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
if [[ "$SKIP" -ne 0 ]]; then
  printf '\nIncomplete: skipped scenarios are reported, not passed.\n'
  exit 3
fi