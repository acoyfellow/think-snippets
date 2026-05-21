#!/usr/bin/env bash
# Live stream-resume-contract lifecycle: deploy on personal CF, probe, destroy.
# Deliberately uses an isolated alchemy app + isolated stage so it cannot
# affect the root think-snippets deployment or the other examples.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

EXAMPLE_DIR="examples/stream-resume-contract"
ALCHEMY_CONFIG="$EXAMPLE_DIR/alchemy.run.ts"
PROBE="$EXAMPLE_DIR/probe.ts"

# Force an isolated stage so two examples never share the same Cloudflare
# resource graph. Default stays personal-only.
export STAGE="${STAGE:-resume}"

cleanup() {
  code=$?
  echo "::group::stream-resume-contract personal cleanup (STAGE=$STAGE)"
  bash scripts/personal-env.sh npx alchemy destroy "$ALCHEMY_CONFIG" --stage "$STAGE" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::personal-account env guard"
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
echo "personal account id length: ${#CLOUDFLARE_PERSONAL_ACCOUNT_ID}"
echo "::endgroup::"

echo "::group::deploy isolated stream-resume-contract Worker"
log="$(mktemp)"
bash scripts/personal-env.sh npx alchemy deploy "$ALCHEMY_CONFIG" --stage "$STAGE" 2>&1 | tee "$log"
WORKER_URL="$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' "$log" | tail -1)"
: "${WORKER_URL:?failed to capture Workers URL from alchemy deploy output}"
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

echo "::group::live stream-resume-contract proof"
bun run "$PROBE"
echo "::endgroup::"

echo "✅ stream-resume-contract live proof passed on personal Cloudflare"
