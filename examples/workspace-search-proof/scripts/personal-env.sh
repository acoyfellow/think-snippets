#!/usr/bin/env bash
# Force every Cloudflare-affecting command onto Jordan's personal CF account.
# Local copy lives inside the example so this directory is self-contained.
set -euo pipefail
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
exec "$@"
