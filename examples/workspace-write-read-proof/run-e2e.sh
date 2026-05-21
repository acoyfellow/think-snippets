#!/usr/bin/env bash
# Live E2E for examples/workspace-write-read-proof.
#
# Self-contained: deploys this example's isolated alchemy app + Worker, runs
# the workspace write/read proof against the live `*.workers.dev` URL, then
# destroys the example's resources on exit. Does not touch any other example.
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
PERSONAL_ENV="$REPO_ROOT/scripts/personal-env.sh"

if [ ! -x "$PERSONAL_ENV" ] && [ ! -r "$PERSONAL_ENV" ]; then
  echo "expected $PERSONAL_ENV; the personal-account guard is required" >&2
  exit 1
fi

export STAGE="${STAGE:-local}"

cleanup() {
  code=$?
  echo "::group::workspace-write-read-proof cleanup"
  ( cd "$EXAMPLE_DIR" && bash "$PERSONAL_ENV" npx alchemy destroy --stage "$STAGE" 2>&1 ) || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck (example-local)"
( cd "$EXAMPLE_DIR" && npx tsc --noEmit -p tsconfig.json )
echo "::endgroup::"

echo "::group::deploy isolated workspace example to personal Cloudflare"
log="$(mktemp)"
( cd "$EXAMPLE_DIR" && bash "$PERSONAL_ENV" npx alchemy deploy --stage "$STAGE" ) 2>&1 | tee "$log"
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

echo "::group::workspace write/read proof"
( cd "$REPO_ROOT" && bun run "$EXAMPLE_DIR/probe.ts" )
echo "::endgroup::"
echo "✅ examples/workspace-write-read-proof E2E passed on personal Cloudflare"
