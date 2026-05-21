#!/usr/bin/env bash
# Isolated copy of the personal-account safety rail for
# examples/clientless-subagent-rpc. Forces every Cloudflare-affecting command
# in this example onto the personal CF account.
set -euo pipefail
: "${CLOUDFLARE_PERSONAL_ACCOUNT_ID:?CLOUDFLARE_PERSONAL_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PERSONAL_API_TOKEN:?CLOUDFLARE_PERSONAL_API_TOKEN is required}"
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
exec "$@"
