#!/usr/bin/env bash
# Force Cloudflare commands for the cross-agent-handoff-envelope example onto
# the personal CF account. Identical contract to the repo-root personal-env.sh,
# duplicated here so this example stands alone.
set -euo pipefail
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
exec "$@"
