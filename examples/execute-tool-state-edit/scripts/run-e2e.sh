#!/usr/bin/env bash
# Self-contained E2E for the execute-tool-state-edit example.
# Deploys the isolated example Worker to Jordan's personal Cloudflare
# account, probes the live sandbox/state behaviour, and tears the
# resources down on exit regardless of pass/fail.
#
# Requires from the environment:
#   CLOUDFLARE_PERSONAL_ACCOUNT_ID
#   CLOUDFLARE_PERSONAL_API_TOKEN
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
EXAMPLE_DIR="$(cd "$HERE/.." && pwd)"

export STAGE="${STAGE:-personal}"

cleanup() {
  code=$?
  echo "::group::personal cleanup"
  bash "$HERE/personal-env.sh" npx alchemy destroy --cwd "$EXAMPLE_DIR" --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

cd "$ROOT"

echo "::group::typecheck example"
npx tsc -p "$EXAMPLE_DIR/tsconfig.json"
echo "::endgroup::"

echo "::group::deploy personal Cloudflare (example-only)"
log="$(mktemp)"
bash "$HERE/personal-env.sh" npx alchemy deploy --cwd "$EXAMPLE_DIR" --stage "$STAGE" 2>&1 | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL}"
export WORKER_URL
echo "deployed=$WORKER_URL"
echo "::endgroup::"

echo "::group::route warmup"
for i in $(seq 1 45); do
  if curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then
    echo "live after $i attempt(s)"; break
  fi
  if [ "$i" = 45 ]; then
    echo "health route did not come live" >&2
    exit 1
  fi
  sleep 2
done
echo "::endgroup::"

# Settle: /health going live does not mean DO-backed routes have fully
# propagated on a brand-new workers.dev hostname. Brief settle avoids the
# cold-route 404/1101 flap on the probe's first non-health request.
sleep 8

echo "::group::live proof"
bun run "$HERE/probe.ts"
echo "::endgroup::"

echo "✅ execute-tool-state-edit E2E passed on personal Cloudflare"
