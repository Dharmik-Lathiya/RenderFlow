#!/usr/bin/env bash
# Phase 1 smoke test: drives the real HTTP API against the local Postgres and
# asserts the Phase 1 DoD (PROJECT.md section 12): a new user always has exactly
# 50 credits, and a duplicate registration never grants twice.
#
# Usage:
#   TEST_DATABASE_URL=postgresql://renderflow:renderflow@127.0.0.1:5433/renderflow \
#   ./scripts/smoke-phase1.sh
set -uo pipefail

PORT="${PORT:-4101}"
BASE="http://localhost:${PORT}"
API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/api" && pwd)"
COOKIE_JAR="$(mktemp)"
LOG="$(mktemp)"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null
  rm -f "$COOKIE_JAR"
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

echo "=== starting API on :${PORT} ==="
(
  cd "$API_DIR"
  NODE_ENV=development \
  LOG_LEVEL=warn \
  API_PORT="$PORT" \
  DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
  JWT_ACCESS_SECRET='smoke-access-secret-long-enough-000000001' \
  JWT_REFRESH_SECRET='smoke-refresh-secret-long-enough-000000002' \
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

EMAIL="smoke-$$@example.com"

echo
echo "=== register ==="
code=$(curl -s -o /tmp/smoke-register.json -w '%{http_code}' \
  -X POST "${BASE}/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -c "$COOKIE_JAR" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"SmokePass123\",\"name\":\"Smoke\"}")
check "register returns 201" "201" "$code"

echo
echo "=== credit invariant (C1) ==="
credits=$(curl -s "${BASE}/api/v1/credits" -b "$COOKIE_JAR")
check "wallet.available == 50" "50" "$(echo "$credits" | sed -n 's/.*"available":\([0-9]*\).*/\1/p' | head -1)"
check "wallet.reserved == 0" "0" "$(echo "$credits" | sed -n 's/.*"reserved":\([0-9]*\).*/\1/p' | head -1)"
check "exactly one SIGNUP_BONUS row" "1" "$(echo "$credits" | grep -o 'SIGNUP_BONUS' | wc -l | tr -d ' ')"

echo
echo "=== authenticated reads ==="
check "GET /me with cookie returns 200" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/v1/me" -b "$COOKIE_JAR")"
check "GET /me without cookie returns 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/v1/me")"

echo
echo "=== duplicate email (C2) ==="
dup=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${BASE}/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"SmokePass123\",\"name\":\"Impostor\"}")
check "duplicate register returns 409" "409" "$dup"

after=$(curl -s "${BASE}/api/v1/credits" -b "$COOKIE_JAR")
check "available still 50 after duplicate" "50" \
  "$(echo "$after" | sed -n 's/.*"available":\([0-9]*\).*/\1/p' | head -1)"
check "still one SIGNUP_BONUS row" "1" "$(echo "$after" | grep -o 'SIGNUP_BONUS' | wc -l | tr -d ' ')"

echo
echo "=== weak password creates nothing ==="
weak_email="weak-$$@example.com"
weak=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${BASE}/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${weak_email}\",\"password\":\"short\",\"name\":\"Weak\"}")
check "weak password returns 400" "400" "$weak"

echo
echo "=== logout revokes the session ==="
csrf=$(grep rf_csrf "$COOKIE_JAR" | awk '{print $7}')
curl -s -o /dev/null -X POST "${BASE}/api/v1/auth/logout" \
  -b "$COOKIE_JAR" -H "x-csrf-token: ${csrf}"
refresh=$(grep rf_refresh "$COOKIE_JAR" | awk '{print $7}')
check "refresh after logout returns 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/v1/auth/refresh" \
     -b "$COOKIE_JAR" -H "x-csrf-token: ${csrf}")"

rm -f /tmp/smoke-register.json
echo
echo "======================================"
printf 'PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || { echo; echo "API log:"; tail -20 "$LOG"; }
exit $(( FAIL > 0 ? 1 : 0 ))