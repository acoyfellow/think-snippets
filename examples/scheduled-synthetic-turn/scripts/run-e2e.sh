#!/usr/bin/env bash
# Isolated E2E for examples/scheduled-synthetic-turn.
#
# Lifecycle:
#   1. typecheck (root tsconfig already includes examples/**)
#   2. deploy this example's Worker via the shared personal-env.sh guard
#   3. warm up the Worker route
#   4. run the scoped probe (trigger -> poll history)
#   5. destroy the example's Worker on exit, regardless of pass/fail
#
# This script never touches the root `think-snippets` app's resources —
# it points alchemy at examples/scheduled-synthetic-turn/alchemy.run.ts,
# which declares its own app name and Worker name.
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
cd "$EXAMPLE_DIR"
export STAGE="${STAGE:-local}"

cleanup() {
  code=$?
  echo "::group::scheduled-synthetic-turn personal cleanup"
  bash "$REPO_ROOT/scripts/personal-env.sh" npx alchemy destroy --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck"
( cd "$REPO_ROOT" && bun run typecheck )
# Also typecheck this example's isolated tsconfig (root tsconfig does not
# include examples/**, by design — each example is self-contained).
( cd "$EXAMPLE_DIR" && npx --no-install tsc --noEmit -p tsconfig.json )
echo "::endgroup::"

echo "::group::deploy scheduled-synthetic-turn (personal account)"
log="$(mktemp)"
bash "$REPO_ROOT/scripts/personal-env.sh" npx alchemy deploy --stage "$STAGE" 2>&1 | tee "$log"
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

echo "::group::live proof"
bun run scripts/probe.ts
echo "::endgroup::"
echo "✅ scheduled-synthetic-turn E2E passed on personal Cloudflare"
