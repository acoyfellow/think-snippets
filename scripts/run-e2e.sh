#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export STAGE="${STAGE:-local}"
cleanup() {
  code=$?
  echo "::group::personal cleanup"
  bash scripts/personal-env.sh npx alchemy destroy --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck"
bun run typecheck
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
  if curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then echo "live after $i attempt(s)"; break; fi
  if [ "$i" = 45 ]; then echo "health route did not come live" >&2; exit 1; fi
  sleep 2
done
echo "::endgroup::"

echo "::group::live proof"
bun run scripts/probe.ts
echo "::endgroup::"
echo "✅ think-snippets E2E passed on personal Cloudflare"
