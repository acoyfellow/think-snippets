#!/usr/bin/env bash
# Force every Cloudflare-affecting command for this example onto
# Jordan's personal CF account. Identical contract to the repo-root
# scripts/personal-env.sh — copied here so this example never depends on
# editing the shared script.
set -euo pipefail
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
exec "$@"
