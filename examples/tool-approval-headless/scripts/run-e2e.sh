#!/usr/bin/env bash
# Isolated deploy -> probe -> destroy for the tool-approval-headless example.
# Never touches the root think-snippets-* Worker.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
cd "$EXAMPLE_DIR"

export STAGE="${STAGE:-approval}"

cleanup() {
  code=$?
  echo "::group::tool-approval cleanup"
  bash "$REPO_ROOT/scripts/personal-env.sh" \
    npx alchemy destroy --stage "$STAGE" --cwd "$EXAMPLE_DIR" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck (isolated)"
bunx tsc --noEmit -p "$EXAMPLE_DIR/tsconfig.json"
echo "::endgroup::"

echo "::group::deploy personal Cloudflare (tool-approval-headless only)"
log="$(mktemp)"
bash "$REPO_ROOT/scripts/personal-env.sh" \
  npx alchemy deploy --stage "$STAGE" --cwd "$EXAMPLE_DIR" 2>&1 | tee "$log"
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

echo "::group::live proof"
bun run "$EXAMPLE_DIR/scripts/probe.ts"
echo "::endgroup::"
echo "✅ tool-approval-headless E2E passed on personal Cloudflare"
