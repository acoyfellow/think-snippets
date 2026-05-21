#!/usr/bin/env bash
# Sequential live verification suite for the isolated Project Think examples.
# Each child script deploys only to CLOUDFLARE_PERSONAL_ACCOUNT_ID, probes, and destroys on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

examples=(
  "rpc-chat-memory:examples/rpc-chat-memory/run-e2e.sh"
  "workspace-write-read-proof:examples/workspace-write-read-proof/run-e2e.sh"
  "workspace-search-proof:examples/workspace-search-proof/scripts/run-e2e.sh"
  "server-tool-audit-loop:examples/server-tool-audit-loop/run-e2e.sh"
  "tool-approval-headless:examples/tool-approval-headless/scripts/run-e2e.sh"
  "hook-order-receipt:examples/hook-order-receipt/run-e2e.sh"
  "clientless-subagent-rpc:examples/clientless-subagent-rpc/run-e2e.sh"
  "cross-agent-handoff-envelope:examples/cross-agent-handoff-envelope/scripts/run-e2e.sh"
  "scheduled-synthetic-turn:examples/scheduled-synthetic-turn/scripts/run-e2e.sh"
  "execute-tool-state-edit:examples/execute-tool-state-edit/scripts/run-e2e.sh"
  "concurrency-latest-vs-queue:examples/concurrency-latest-vs-queue/run.sh"
  "multi-tab-broadcast-protocol:examples/multi-tab-broadcast-protocol/scripts/run-e2e.sh"
  "stream-resume-contract:examples/stream-resume-contract/run.sh"
)

for item in "${examples[@]}"; do
  name="${item%%:*}"
  script="${item#*:}"
  echo "::group::example $name"
  # Short and unique enough for workers.dev names that include stage.
  # Short stages keep the workers.dev host compact and, empirically, avoid a
  # transient Workers edge 404 seen with longer freshly-minted hostnames.
  stage="a$(printf '%s' "$name" | shasum | cut -c1-3)"
  STAGE="$stage" bash "$script"
  echo "::endgroup::"
done

echo "✅ all isolated Think examples passed live personal-Cloudflare E2E"
