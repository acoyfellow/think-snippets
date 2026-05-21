#!/usr/bin/env bash
# Personal-account-only E2E for the multi-tab broadcast example.
# Deploys an ISOLATED Worker + DO (separate alchemy app from the repo root),
# runs the headless two-client probe, and destroys everything on exit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$REPO_ROOT"
export STAGE="${STAGE:-multitab}"
EX_DIR="examples/multi-tab-broadcast-protocol"
ALCHEMY_CONFIG="$EX_DIR/alchemy.run.ts"
PROBE="$EX_DIR/scripts/probe.ts"
PERSONAL_ENV="$EX_DIR/scripts/personal-env.sh"

cleanup() {
  code=$?
  echo "::group::personal cleanup"
  bash "$PERSONAL_ENV" npx alchemy destroy "$ALCHEMY_CONFIG" --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck"
bun run typecheck
npx tsc --noEmit -p "$EX_DIR/tsconfig.json"
echo "::endgroup::"

echo "::group::deploy personal Cloudflare (isolated multi-tab-broadcast app)"
log="$(mktemp)"
bash "$PERSONAL_ENV" npx alchemy deploy "$ALCHEMY_CONFIG" --stage "$STAGE" 2>&1 | tee "$log"
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

echo "::group::live proof (two AgentClient sockets → one Think DO)"
bun run "$PROBE"
echo "::endgroup::"
echo "✅ multi-tab-broadcast-protocol E2E passed on personal Cloudflare"
