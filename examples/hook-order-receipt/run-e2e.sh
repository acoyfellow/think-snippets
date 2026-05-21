#!/usr/bin/env bash
# Isolated E2E for examples/hook-order-receipt.
#
# Deploys ONLY this example's Worker + DurableObject under the personal
# Cloudflare account via scripts/personal-env.sh, captures the live
# *.workers.dev URL, runs the per-example probe, and destroys the example's
# resources on exit. It deliberately does not touch the repo-level
# `think-snippets` worker or the shared probe.
set -euo pipefail
EXAMPLE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
cd "$REPO_ROOT"
export STAGE="${STAGE:-local}"
ALCHEMY_FILE="examples/hook-order-receipt/alchemy.run.ts"

cleanup() {
  code=$?
  echo "::group::personal cleanup (hook-order-receipt)"
  bash scripts/personal-env.sh npx alchemy destroy "$ALCHEMY_FILE" --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck (hook-order-receipt)"
# Local per-example typecheck only — does not depend on the shared tsconfig.
bunx tsc --noEmit -p "$EXAMPLE_DIR/tsconfig.json"
echo "::endgroup::"

echo "::group::deploy (personal account, hook-order-receipt)"
log="$(mktemp)"
bash scripts/personal-env.sh npx alchemy deploy "$ALCHEMY_FILE" --stage "$STAGE" 2>&1 | tee "$log"
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

echo "::group::live proof (hook-order-receipt probe)"
bun run "$EXAMPLE_DIR/probe.ts"
echo "::endgroup::"
echo "✅ hook-order-receipt E2E passed on personal Cloudflare"
