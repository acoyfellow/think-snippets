#!/usr/bin/env bash
# Live E2E for examples/rpc-chat-memory.
#
# 1. typechecks this example only
# 2. deploys an isolated Worker + DO to the personal Cloudflare account
# 3. curls the live workers.dev URL to assert /health attestation
# 4. drives two HTTP POSTs at the same session and asserts the second answer
#    recalls the calibration word from the first — i.e. Think.chat() streamed
#    RPC turns persist across requests
# 5. always destroys the isolated example Worker + DO on exit
set -euo pipefail
cd "$(dirname "$0")"
export STAGE="${STAGE:-local}"

cleanup() {
  code=$?
  echo "::group::rpc-chat-memory personal cleanup"
  bash personal-env.sh npx alchemy destroy --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::rpc-chat-memory typecheck"
npx tsc --noEmit -p tsconfig.json
echo "::endgroup::"

echo "::group::rpc-chat-memory deploy personal Cloudflare only"
log="$(mktemp)"
bash personal-env.sh npx alchemy deploy --stage "$STAGE" 2>&1 | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL}"
export WORKER_URL
echo "deployed=$WORKER_URL"
echo "::endgroup::"

echo "::group::rpc-chat-memory route warmup"
for i in $(seq 1 45); do
  if curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then echo "live after $i attempt(s)"; break; fi
  if [ "$i" = 45 ]; then echo "health route did not come live" >&2; exit 1; fi
  sleep 2
done
echo "::endgroup::"

# Settle: /health going live does not mean DO-backed routes have fully
# propagated on a brand-new workers.dev hostname. Brief settle avoids the
# cold-route 404/1101 flap on the probe's first non-health request.
sleep 8

echo "::group::rpc-chat-memory live proof"
bun run probe.ts
echo "::endgroup::"
echo "✅ examples/rpc-chat-memory E2E passed on personal Cloudflare"
