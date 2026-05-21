#!/usr/bin/env bash
# Isolated live E2E for the rpc-init-safety example.
#
# - Uses the repo personal-env.sh wrapper to enforce the personal Cloudflare
#   account env mapping; the example's alchemy.run.ts hard-fails if that
#   mapping is not present at deploy time.
# - Deploys against this example directory only (--root-dir points here, so
#   Alchemy state lives under examples/rpc-init-safety/.alchemy and cannot
#   touch the repo-root think-snippets app).
# - Always destroys on exit.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

export STAGE="${STAGE:-local}"
PERSONAL_ENV="$REPO_ROOT/scripts/personal-env.sh"
ENTRYPOINT="$HERE/alchemy.run.ts"

cleanup() {
  code=$?
  echo "::group::rpc-init-safety personal cleanup"
  bash "$PERSONAL_ENV" npx alchemy destroy --stage "$STAGE" --root-dir "$HERE" "$ENTRYPOINT" 2>&1 || true
  echo "::endgroup::"
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "::group::typecheck (repo root)"
bun run typecheck
echo "::endgroup::"

echo "::group::typecheck (example)"
npx tsc --noEmit -p "$HERE/tsconfig.json"
echo "::endgroup::"

echo "::group::deploy rpc-init-safety to personal Cloudflare"
log="$(mktemp)"
bash "$PERSONAL_ENV" npx alchemy deploy --stage "$STAGE" --root-dir "$HERE" "$ENTRYPOINT" 2>&1 | tee "$log"
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
bun run "$HERE/scripts/probe.ts"
echo "::endgroup::"
echo "✅ rpc-init-safety E2E passed on personal Cloudflare"
