#!/usr/bin/env bash
#
# Runs the browser journey, or says plainly why it cannot.
#
# The rule this follows is the one `tests/chaos/run.sh` already follows: a
# harness that reports success for what it did not do is worse than no harness.
# So an absent browser, an absent Playwright, or an unreachable stack all produce
# a SKIP and a non-zero exit - never a pass.
#
#   ./scripts/e2e.sh              # run, or report SKIP
#   E2E_BASE_URL=... ./scripts/e2e.sh
#
# The specs themselves have NEVER been executed in the environment this was
# written in: there is no browser and no Docker. That is stated in
# tests/e2e/playwright.config.ts and in PROJECT.md section 12, and it is not
# something a green unit suite papers over.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="$ROOT/tests/e2e"
BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"

pass=0
skip=0
skipped=()

note() { printf '  %s\n' "$*"; }

printf '=== browser journey ===\n'

if [[ ! -d "$E2E_DIR" ]]; then
  printf 'SKIP  tests/e2e is missing.\n'
  printf '\nPASS: %d   SKIP: %d\n' "$pass" "$((skip + 1))"
  printf 'Incomplete: the browser journey was not run.\n'
  exit 3
fi

# 1. Playwright installed?
if ! command -v npx >/dev/null 2>&1 || ! npx --no-install playwright --version >/dev/null 2>&1; then
  skipped+=("playwright is not installed")
  note "SKIP  playwright is not installed."
  note "      pnpm add -D @playwright/test && pnpm exec playwright install --with-deps chromium"
fi

# 2. A browser binary?
if [[ ${#skipped[@]} -eq 0 ]] && ! pnpm exec playwright install --dry-run >/dev/null 2>&1; then
  skipped+=("no browser binary")
  note "SKIP  no Playwright browser binary."
  note "      pnpm exec playwright install chromium"
fi

# 3. The app reachable?
if ! curl -sf -o /dev/null --max-time 5 "$BASE_URL"; then
  skipped+=("the web app is not running at $BASE_URL")
  note "SKIP  the web app is not reachable at $BASE_URL."
  note "      docker compose up --build   (or: pnpm dev)"
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
  printf '\nPASS: %d   SKIP: %d\n' "$pass" "${#skipped[@]}"
  printf '\nSkipped because:\n'
  for reason in "${skipped[@]}"; do
    printf '  - %s\n' "$reason"
  done
  printf '\nIncomplete: the browser journey was NOT run. These results are not a pass.\n'
  exit 3
fi

# Everything is present, so run for real.
printf '\nRunning against %s\n\n' "$BASE_URL"

if pnpm exec playwright test --config "$E2E_DIR/playwright.config.ts"; then
  printf '\nPASS: all browser journeys passed.\n'
  exit 0
fi

printf '\nFAILED: the browser journey did not pass.\n'
exit 1