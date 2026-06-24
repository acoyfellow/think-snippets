#!/usr/bin/env bash
# Isolated live E2E for examples/workspace-search-proof.
# Cleans up Cloudflare resources on every exit path (success, failure, signal).
set -euo pipefail
cd "$(dirname "$0")/.."
export STAGE="${STAGE:-local}"

cleanup() {
  code=$?
  echo "::group::workspace-search-proof personal cleanup"
  bash scripts/personal-env.sh npx alchemy destroy --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::workspace-search-proof typecheck"
npx tsc --noEmit -p tsconfig.json
echo "::endgroup::"

echo "::group::workspace-search-proof deploy (personal Cloudflare only)"
log="$(mktemp)"
bash scripts/personal-env.sh npx alchemy deploy --stage "$STAGE" 2>&1 | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL}"
export WORKER_URL
echo "deployed=$WORKER_URL"
echo "::endgroup::"

echo "::group::workspace-search-proof route warmup"
for i in $(seq 1 45); do
  if curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then
    echo "live after $i attempt(s)"
    break
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

echo "::group::workspace-search-proof live proof"
bun run scripts/probe.ts
echo "::endgroup::"
echo "✅ workspace-search-proof E2E passed on personal Cloudflare"
