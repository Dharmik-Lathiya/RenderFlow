#!/usr/bin/env bash
# scripts/pre-deploy-check.sh
#
# Pre-deployment checklist for RenderFlow.
# Runs 8 checks and exits 0 only if all pass.
#
# Usage:
#   bash scripts/pre-deploy-check.sh
#
# Set env vars before running (either export them or source your .env first):
#   source .env && bash scripts/pre-deploy-check.sh
#
# AGENTS.md §10 / DEPLOYMENT.md §4 list all required variables.

set -euo pipefail

PASS=0
FAIL=0
RESULTS=()

check() {
  local number="$1"
  local description="$2"
  local result="$3"  # 'pass' or 'fail'
  local detail="${4:-}"

  if [[ "$result" == "pass" ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("  [PASS] #${number}: ${description}")
  else
    FAIL=$((FAIL + 1))
    local msg="  [FAIL] #${number}: ${description}"
    if [[ -n "$detail" ]]; then
      msg="${msg} — ${detail}"
    fi
    RESULTS+=("$msg")
  fi
}

# ---------------------------------------------------------------------------
# Check 1 — NODE_ENV=production
# ---------------------------------------------------------------------------
if [[ "${NODE_ENV:-}" == "production" ]]; then
  check 1 "NODE_ENV=production" pass
else
  check 1 "NODE_ENV=production" fail "got '${NODE_ENV:-<unset>}'"
fi

# ---------------------------------------------------------------------------
# Check 2 — JWT_ACCESS_SECRET length >= 32
# ---------------------------------------------------------------------------
if [[ -n "${JWT_ACCESS_SECRET:-}" && ${#JWT_ACCESS_SECRET} -ge 32 ]]; then
  check 2 "JWT_ACCESS_SECRET length >= 32" pass
else
  check 2 "JWT_ACCESS_SECRET length >= 32" fail \
    "length=${#JWT_ACCESS_SECRET:-0}; generate with: openssl rand -base64 48"
fi

# ---------------------------------------------------------------------------
# Check 3 — JWT_REFRESH_SECRET length >= 32
# ---------------------------------------------------------------------------
if [[ -n "${JWT_REFRESH_SECRET:-}" && ${#JWT_REFRESH_SECRET} -ge 32 ]]; then
  check 3 "JWT_REFRESH_SECRET length >= 32" pass
else
  check 3 "JWT_REFRESH_SECRET length >= 32" fail \
    "length=${#JWT_REFRESH_SECRET:-0}; generate with: openssl rand -base64 48"
fi

# ---------------------------------------------------------------------------
# Check 4 — TOKEN_ENCRYPTION_KEY is set
# ---------------------------------------------------------------------------
if [[ -n "${TOKEN_ENCRYPTION_KEY:-}" ]]; then
  check 4 "TOKEN_ENCRYPTION_KEY is set" pass
else
  check 4 "TOKEN_ENCRYPTION_KEY is set" fail \
    "generate with: openssl rand -base64 32"
fi

# ---------------------------------------------------------------------------
# Check 5 — EMAIL_PROVIDER != 'log'
# ---------------------------------------------------------------------------
if [[ "${EMAIL_PROVIDER:-}" != "log" && -n "${EMAIL_PROVIDER:-}" ]]; then
  check 5 "EMAIL_PROVIDER != 'log'" pass
else
  if [[ "${EMAIL_PROVIDER:-}" == "log" ]]; then
    check 5 "EMAIL_PROVIDER != 'log'" fail \
      "'log' is refused in production; use 'none' or a real provider"
  else
    check 5 "EMAIL_PROVIDER != 'log'" fail \
      "EMAIL_PROVIDER is unset; set to 'none' (no mail) or a real provider"
  fi
fi

# ---------------------------------------------------------------------------
# Check 6 — DATABASE_URL is set
# ---------------------------------------------------------------------------
if [[ -n "${DATABASE_URL:-}" ]]; then
  check 6 "DATABASE_URL is set" pass
else
  check 6 "DATABASE_URL is set" fail "required; set to your Neon/PostgreSQL connection string"
fi

# ---------------------------------------------------------------------------
# Check 7 — REDIS_URL is set
# ---------------------------------------------------------------------------
if [[ -n "${REDIS_URL:-}" ]]; then
  check 7 "REDIS_URL is set" pass
else
  check 7 "REDIS_URL is set" fail "required; set to your Upstash/Redis URL"
fi

# ---------------------------------------------------------------------------
# Check 8 — CORS_ORIGINS is set and does not contain 'localhost' in production
# ---------------------------------------------------------------------------
if [[ -z "${CORS_ORIGINS:-}" ]]; then
  check 8 "CORS_ORIGINS is set and does not contain 'localhost'" fail \
    "CORS_ORIGINS is unset; set it to your Vercel/web origin"
elif [[ "${NODE_ENV:-}" == "production" ]] && echo "${CORS_ORIGINS}" | grep -qi "localhost"; then
  check 8 "CORS_ORIGINS is set and does not contain 'localhost'" fail \
    "CORS_ORIGINS='${CORS_ORIGINS}' contains 'localhost' — this must be an HTTPS origin"
else
  check 8 "CORS_ORIGINS is set and does not contain 'localhost'" pass
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))

echo ""
echo "RenderFlow pre-deploy checklist"
echo "================================"
for result in "${RESULTS[@]}"; do
  echo "$result"
done
echo ""
echo "${PASS}/${TOTAL} checks passed"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "Fix the failing checks before deploying."
  echo "See DEPLOYMENT.md §4 and issues/DEPLOYMENT-DEMO.md for guidance."
  exit 1
fi

echo "All checks passed. Safe to deploy."
exit 0
