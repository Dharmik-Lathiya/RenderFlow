#!/usr/bin/env bash
# Phase 4 smoke test: the job pipeline, end to end, against the real HTTP API
# and the local Postgres. Asserts the Phase 4 DoD (PROJECT.md section 12):
# "creating a reel job reserves 30, progresses through all stages visible via
# SSE, ends with capture; forced failure ends with refund".
#
# Usage:
#   TEST_DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow \
#   DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate && DATABASE_URL=$TEST_DATABASE_URL pnpm db:seed
#   ./scripts/smoke-phase4.sh
#
# `db:seed` is required, not optional: prices live in `pricing_rules` (AGENTS.md
# rule 6), so an unseeded database fails every reservation with a 500.
#
# Why the worker runs inline
# -------------------------
# The integration suites already prove the pipeline against a real database, and
# they run each worker directly. This script proves the part a unit test cannot:
# the HTTP surface, the SSE stream and the real database agreeing with each other.
#
# It calls `processJob` in-process rather than going through BullMQ because there
# is no Redis here. That is a real limitation and it is the same one recorded in
# PROJECT.md's Phase 4 known gaps: the queue hop itself is unexercised until
# `docker compose up` is available.
set -uo pipefail

PORT="${PORT:-4104}"
BASE="http://localhost:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="${ROOT}/apps/api"
LOG="$(mktemp)"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'PASS  %-58s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-58s expected=%s actual=%s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'PASS  %-58s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-58s missing=%s\n' "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

json() { # json <field> ; reads stdin
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=$1;process.stdout.write(v===undefined||v===null?'':String(v))}catch{process.stdout.write('')}})"
}

echo "=== starting API on :${PORT} ==="
(
  cd "$API_DIR"
  NODE_ENV=development \
  LOG_LEVEL=warn \
  API_PORT="$PORT" \
  DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
  JWT_ACCESS_SECRET='smoke-access-secret-long-enough-000000001' \
  JWT_REFRESH_SECRET='smoke-refresh-secret-long-enough-000000002' \
  SIGNUP_BONUS_CREDITS=50 \
  S3_ACCESS_KEY=minio S3_SECRET_KEY=minio12345 \
  S3_ENDPOINT=http://localhost:9000 S3_BUCKET=renderflow-assets S3_REGION=us-east-1 \
  RATE_LIMIT_LOGIN_IP=100/15m \
  RATE_LIMIT_LOGIN_ACCOUNT=100/1h \
  RATE_LIMIT_REGISTER_IP=100/1h \
  RATE_LIMIT_REFRESH_IP=100/15m \
  node dist/main.js
) >"$LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 30); do
  curl -fsS "${BASE}/health/live" >/dev/null 2>&1 && break
  sleep 0.5
done

if ! curl -fsS "${BASE}/health/live" >/dev/null 2>&1; then
  echo "API failed to start:"; cat "$LOG"; exit 1
fi

EMAIL="smoke4-$$@example.com"
TOKEN=""

# Named explicitly rather than read off the global: `register` reassigns TOKEN,
# and a section that quietly acted as the newest account would pass while
# testing nothing.
OWNER=""

# Sets TOKEN. Bearer rather than cookies: the documented mobile flow, and it
# keeps this script out of the CSRF cookie dance that smoke-phase1 covers.
register() {
  local body token
  body=$(curl -s -X POST "${BASE}/api/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"SmokePass123\",\"name\":\"Smoke\"}")
  token=$(echo "$body" | json 'o.accessToken')
  TOKEN="$token"
}

jget() { # jget <path> <token>
  curl -s "${BASE}/api/v1/$1" -H "Authorization: Bearer $2"
}

jpost() { # jpost <path> <json> <token>
  curl -s -X POST "${BASE}/api/v1/$1" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $3" \
    -d "$2"
}

# Runs the pipeline the way a worker would: content stages first, then media.
# Two invocations rather than one, because that is the actual architecture - see
# PROJECT.md section 8, "Routing by stage".
run_pipeline() {
  local job_id="$1" token="$2" fail_stage="${3:-}"
  JOB_ID="$job_id" FAIL_STAGE="$fail_stage" TOKEN="$token" \
    DATABASE_URL="${TEST_DATABASE_URL}" \
    node "${ROOT}/tests/tools/run-job-once.mjs"
}

echo
echo "=== register ==="
register "$EMAIL"
OWNER="$TOKEN"
check "register returns a token" "yes" "$([[ -n "$OWNER" ]] && echo yes || echo no)"

WORKSPACE=$(jget workspaces "$OWNER" | json 'o[0].id')
BRAND=$(jpost brands "{\"workspaceId\":\"${WORKSPACE}\",\"name\":\"Acme\",\"industry\":\"retail\"}" "$OWNER" | json 'o.id')
CAMPAIGN=$(jpost campaigns "{\"brandId\":\"${BRAND}\",\"goal\":\"launch\"}" "$OWNER" | json 'o.id')
POST=$(jpost posts "{\"campaignId\":\"${CAMPAIGN}\",\"type\":\"CAPTION\",\"caption\":\"Hello\"}" "$OWNER" | json 'o.id')
check "brand, campaign and post created" "yes" "$([[ -n "$POST" ]] && echo yes || echo no)"

echo
echo "=== reserve on request (C3) ==="
CREATED=$(jpost "posts/${POST}/generate" '{"type":"REEL","scenes":3,"images":3}' "$OWNER")
JOB=$(echo "$CREATED" | json 'o.job.id')
check "POST generate returns a job" "yes" "$([[ -n "$JOB" ]] && echo yes || echo no)"
check "job reserves 30" "30" "$(echo "$CREATED" | json 'o.job.creditsReserved')"
check "job starts PENDING at PLAN" "PENDING" "$(echo "$CREATED" | json 'o.job.status')"
check "job stage is PLAN" "PLAN" "$(echo "$CREATED" | json 'o.job.stage')"

WALLET=$(jget credits "$OWNER")
check "available is 20 after reserving 30" "20" "$(echo "$WALLET" | json 'o.wallet.available')"
check "reserved is 30" "30" "$(echo "$WALLET" | json 'o.wallet.reserved')"

echo
echo "=== the API does not run the job itself ==="
BEFORE=$(jget "jobs/${JOB}" "$OWNER")
check "no stages completed before a worker runs" "0" "$(echo "$BEFORE" | json 'o.completedStages.length')"

echo
echo "=== two workers, five stages (Phase 4 DoD) ==="
run_pipeline "$JOB" "$OWNER" >/dev/null 2>&1
JOB_STATUS=$(jget "jobs/${JOB}" "$OWNER")
check "status COMPLETED" "COMPLETED" "$(echo "$JOB_STATUS" | json 'o.status')"
check "stage DONE" "DONE" "$(echo "$JOB_STATUS" | json 'o.stage')"
check "captured" "true" "$(echo "$JOB_STATUS" | json 'o.captured')"
check "not refunded" "false" "$(echo "$JOB_STATUS" | json 'o.refunded')"
check "all five stages checkpointed" "PLAN,SCRIPT,IMAGE,VOICE,RENDER" \
  "$(echo "$JOB_STATUS" | json 'o.completedStages.join(",")')"

echo
echo "=== capture on success (C6) ==="
WALLET=$(jget credits "$OWNER")
check "available stays 20 - the user paid" "20" "$(echo "$WALLET" | json 'o.wallet.available')"
check "reserved back to 0" "0" "$(echo "$WALLET" | json 'o.wallet.reserved')"

echo
echo "=== SSE progress (C12) ==="
SSE=$(curl -s -m 20 "${BASE}/api/v1/jobs/${JOB}/events" -H "Authorization: Bearer ${TOKEN}")
contains "stream carries a progress event" "event: progress" "$SSE"
contains "progress reports COMPLETED" '"status":"COMPLETED"' "$SSE"
contains "stream closes with done" "event: done" "$SSE"

echo
echo "=== tenancy ==="
register "smoke4-other-$$@example.com"
OTHER_TOKEN="$TOKEN"
check "another user cannot read the job" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/v1/jobs/${JOB}" -H "Authorization: Bearer ${OTHER_TOKEN}")"
check "another user cannot stream it either" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/v1/jobs/${JOB}/events" -H "Authorization: Bearer ${OTHER_TOKEN}")"

echo
echo "=== a second reel the user cannot afford (C4) ==="
SECOND=$(jpost "posts/${POST}/generate" '{"type":"REEL"}' "$OWNER")
# The body's `code` is the stable error code; the 402 is the HTTP status the
# filter maps it to.
check "second reel is refused as INSUFFICIENT_CREDITS" "INSUFFICIENT_CREDITS" \
  "$(echo "$SECOND" | json 'o.code')"
check "balance untouched by the refusal" "20" "$(jget credits "$OWNER" | json 'o.wallet.available')"
# Exactly one RESERVE, not two: the guarded UPDATE moved nothing, so the ledger
# must not have grown either.
check "only one RESERVE in the ledger" "1" \
  "$(jget credits "$OWNER" | json 'o.ledger.filter((e) => e.entryType === "RESERVE").length')"
check "the finished job is unaffected" "COMPLETED" \
  "$(jget "jobs/${JOB}" "$OWNER" | json 'o.status')"

echo
echo "=== forced failure refunds (C7) ==="
# A separate account: the first has 20 left, which cannot fund another reel.
# Refunding the job that just failed is the only way to get the credits back,
# so testing the refund through the user who could not afford it proves nothing.
register "smoke4-refund-$$@example.com"
REFUND_TOKEN="$TOKEN"
REFUND_WS=$(jget workspaces "$REFUND_TOKEN" | json 'o[0].id')
REFUND_BRAND=$(jpost brands "{\"workspaceId\":\"${REFUND_WS}\",\"name\":\"Refund Inc\",\"industry\":\"retail\"}" "$REFUND_TOKEN" | json 'o.id')
REFUND_CAMPAIGN=$(jpost campaigns "{\"brandId\":\"${REFUND_BRAND}\",\"goal\":\"launch\"}" "$REFUND_TOKEN" | json 'o.id')
REFUND_POST=$(jpost posts "{\"campaignId\":\"${REFUND_CAMPAIGN}\",\"type\":\"CAPTION\",\"caption\":\"Hello\"}" "$REFUND_TOKEN" | json 'o.id')

REFUND_JOB=$(jpost "posts/${REFUND_POST}/generate" '{"type":"REEL","scenes":2,"images":2}' "$REFUND_TOKEN" | json 'o.job.id')
check "refund case reserves 30" "20" "$(jget credits "$REFUND_TOKEN" | json 'o.wallet.available')"

run_pipeline "$REFUND_JOB" "$REFUND_TOKEN" "RENDER" >/dev/null 2>&1
FAILED_STATUS=$(jget "jobs/${REFUND_JOB}" "$REFUND_TOKEN")
check "job FAILED" "FAILED" "$(echo "$FAILED_STATUS" | json 'o.status')"
check "refunded" "true" "$(echo "$FAILED_STATUS" | json 'o.refunded')"
check "not captured" "false" "$(echo "$FAILED_STATUS" | json 'o.captured')"
check "error names the failing stage" "true" \
  "$(echo "$FAILED_STATUS" | json 'String(o.error).includes("RENDER")')"
check "stages that did finish are still reported" "PLAN,SCRIPT,IMAGE,VOICE" \
  "$(echo "$FAILED_STATUS" | json 'o.completedStages.join(",")')"

WALLET=$(jget credits "$REFUND_TOKEN")
check "credits returned in full" "50" "$(echo "$WALLET" | json 'o.wallet.available')"
check "nothing still reserved" "0" "$(echo "$WALLET" | json 'o.wallet.reserved')"

echo
echo "======================================"
printf 'PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || { echo "--- api log ---"; cat "$LOG"; exit 1; }