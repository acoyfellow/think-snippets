#!/usr/bin/env bash
# Isolated E2E for the concurrency-latest-vs-queue example.
#
# This script:
#   1. Typechecks just this example.
#   2. Deploys an isolated alchemy app (`concurrency-latest-vs-queue`) to the
#      personal Cloudflare account via the shared personal-env.sh guard
#      (called, not edited).
#   3. Runs the live WebSocket-driven probe.
#   4. Destroys the isolated app on exit (success or failure).
#
# It NEVER touches the parent `think-snippets` alchemy app — different app
# name, different worker name, different bindings.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="${STAGE:-personal}"
export STAGE

cleanup() {
  code=$?
  echo "::group::concurrency-latest-vs-queue cleanup"
  (cd "$HERE" && bash "$ROOT/scripts/personal-env.sh" npx alchemy destroy --stage "$STAGE" 2>&1) || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck (isolated)"
(cd "$HERE" && npx tsc --noEmit -p "$HERE/tsconfig.json")
echo "::endgroup::"

echo "::group::deploy isolated alchemy app to personal Cloudflare"
log="$(mktemp)"
(cd "$HERE" && bash "$ROOT/scripts/personal-env.sh" npx alchemy deploy --stage "$STAGE" 2>&1) | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL}"
export WORKER_URL
echo "deployed=$WORKER_URL"
echo "::endgroup::"

echo "::group::route warmup"
for i in $(seq 1 45); do
  if curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then echo "live after $i attempt(s)"; break; fi
  if [ "$i" = 45 ]; then echo "health route did not come live" >&2; exit 1; fi
  sleep 2
done
echo "::endgroup::"

echo "::group::live concurrency probe"
(cd "$HERE" && bun run "$HERE/probe.ts")
echo "::endgroup::"

echo "✅ concurrency-latest-vs-queue isolated E2E passed on personal Cloudflare"
