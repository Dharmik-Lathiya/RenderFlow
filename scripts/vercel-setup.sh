#!/usr/bin/env bash
# Configures a linked Vercel project so the deployment matches this repository.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# Vercel stores most build settings in the project dashboard, not in the repo.
# That meant a fresh clone could not reproduce a deployment: four settings had to
# be set by hand, by memory, with no record of them in version control.
#
# Three of them CAN live in the repo and now do, in vercel.json:
#   framework, installCommand, buildCommand, outputDirectory.
#
# The fourth, `rootDirectory`, CANNOT. Vercel does not accept it in vercel.json.
# It is also not optional: the Next.js framework preset resolves the app relative
# to rootDirectory, and without it Vercel builds the repo root, finds no app, and
# deploys an output with no routes - every request answers 404 NOT_FOUND even
# though the build reports success.
#
# That was tried and measured rather than assumed; see PROJECT.md section 11.5.
# So the honest position is: one dashboard setting is unavoidable, this script
# applies it idempotently, and everything else is in the repository.
#
# USAGE
# -----
#   vercel link --yes --project renderflow     # once, to link the directory
#   scripts/vercel-setup.sh                    # apply/verify the settings
#   vercel --prod
#
# Run against a backup of any production project: it mutates project settings.
set -euo pipefail

PROJECT="${1:-renderflow}"
API="https://api.vercel.com/v9/projects/${PROJECT}"
ROOT_DIRECTORY="apps/web"

log() { printf '[vercel-setup] %s\n' "$1"; }
die() { printf '[vercel-setup] ERROR: %s\n' "$1" >&2; exit 1; }

# The CLI stores its token here; reuse it rather than asking the user to paste one.
AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli/auth.json"
[ -f "$AUTH_FILE" ] || die "no Vercel auth found at $AUTH_FILE. Run 'vercel link' first."
TOKEN="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('token',''))" "$AUTH_FILE")"
[ -n "$TOKEN" ] || die "Vercel auth file contains no token. Run 'vercel login'."

current() {
  curl -sS -H "Authorization: Bearer ${TOKEN}" "$API"
}

log "checking project '${PROJECT}'"

BEFORE="$(current)"
CURRENT_ROOT="$(printf '%s' "$BEFORE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("rootDirectory") or "")')"

if [ "$CURRENT_ROOT" = "$ROOT_DIRECTORY" ]; then
  log "rootDirectory already '${ROOT_DIRECTORY}' - nothing to change"
else
  log "setting rootDirectory to '${ROOT_DIRECTORY}' (currently '${CURRENT_ROOT:-<unset>}')"
  curl -sS -X PATCH "$API" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "{\"rootDirectory\": \"${ROOT_DIRECTORY}\", \"framework\": \"nextjs\"}" >/dev/null
fi

# Report the effective configuration so drift is visible without the dashboard.
#
# What is being checked: settings supplied by vercel.json are applied at BUILD
# time and never appear in the project object, so an absent value here means "no
# dashboard override" - which is exactly the desired state, since the repository
# is the single source of truth. A POPULATED value would be the problem: it would
# silently win over vercel.json.
echo "[vercel-setup] project-level overrides (all three should be empty):"
current | python3 -c '
import json, sys
d = json.load(sys.stdin)
for k in ("installCommand", "buildCommand", "outputDirectory"):
    value = d.get(k)
    flag = "" if not value else "   <-- OVERRIDES vercel.json"
    print("[vercel-setup]   %s: %r%s" % (k, value, flag))
print("[vercel-setup]   rootDirectory: %r  (cannot live in vercel.json)" % d.get("rootDirectory"))
'

log "checking vercel.json covers the rest"
python3 - <<'PY'
import json, pathlib, sys

path = pathlib.Path("vercel.json")
if not path.exists():
    sys.exit("[vercel-setup] ERROR: vercel.json is missing from the repository root")

config = json.loads(path.read_text())
required = ["framework", "installCommand", "buildCommand", "outputDirectory"]
missing = [key for key in required if not config.get(key)]
if missing:
    sys.exit(f"[vercel-setup] ERROR: vercel.json is missing {missing}")

print("[vercel-setup] vercel.json covers " + ", ".join(required))
PY

log "ready: run 'vercel --prod'"