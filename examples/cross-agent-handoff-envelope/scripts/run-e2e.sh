#!/usr/bin/env bash
# Isolated E2E for the cross-agent-handoff-envelope example.
# Deploys via the example's own alchemy app, runs the live probe, destroys on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
export STAGE="${STAGE:-handoff}"

cleanup() {
  code=$?
  echo "::group::personal cleanup"
  bash scripts/personal-env.sh npx alchemy destroy --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck"
bash scripts/personal-env.sh npx tsc --noEmit -p tsconfig.json
echo "::endgroup::"

echo "::group::deploy personal Cloudflare only"
log="$(mktemp)"
bash scripts/personal-env.sh npx alchemy deploy --stage "$STAGE" 2>&1 | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL}"
export WORKER_URL
echo "deployed=$WORKER_URL"
echo "::endgroup::"

echo "::group::route warmup"
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

echo "::group::live proof"
bun run scripts/probe.ts
echo "::endgroup::"

echo "✅ cross-agent-handoff-envelope E2E passed on personal Cloudflare"
