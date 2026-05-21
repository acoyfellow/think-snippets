#!/usr/bin/env bash
# Force every Cloudflare-affecting command in this example onto the personal CF account.
# Mirrors the repo-root scripts/personal-env.sh, kept local to preserve isolation.
set -euo pipefail
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
exec "$@"
