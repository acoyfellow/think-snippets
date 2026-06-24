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
  "effect-hello:examples/effect-hello/run-e2e.sh"
  "tool-approval-headless:examples/tool-approval-headless/scripts/run-e2e.sh"
  "hook-order-receipt:examples/hook-order-receipt/run-e2e.sh"
  "clientless-subagent-rpc:examples/clientless-subagent-rpc/run-e2e.sh"
  "cross-agent-handoff-envelope:examples/cross-agent-handoff-envelope/scripts/run-e2e.sh"
  "scheduled-synthetic-turn:examples/scheduled-synthetic-turn/scripts/run-e2e.sh"
  "execute-tool-state-edit:examples/execute-tool-state-edit/scripts/run-e2e.sh"
  "concurrency-latest-vs-queue:examples/concurrency-latest-vs-queue/run.sh"
  "multi-tab-broadcast-protocol:examples/multi-tab-broadcast-protocol/scripts/run-e2e.sh"
  "stream-resume-contract:examples/stream-resume-contract/run.sh"
  "cli-http-ground-truth:examples/cli-http-ground-truth/run-e2e.sh"
  "cli-sandbox-ground-truth:examples/cli-sandbox-ground-truth/scripts/run-e2e.sh"
)

for item in "${examples[@]}"; do
  name="${item%%:*}"
  script="${item#*:}"
  echo "::group::example $name"
  # Short and unique enough for workers.dev names that include stage.
  # Short stages keep the workers.dev host compact and, empirically, avoid a
  # transient Workers edge 404 seen with longer freshly-minted hostnames.
  stage="a$(printf '%s' "$name" | shasum | cut -c1-3)"
  # Retry a whole example once if it trips the known fresh-route edge flap
  # (transient 404/1101 HTML before the new workers.dev route fully
  # propagates). The example always destroys its own resources on exit, so a
  # retry just redeploys cleanly. A second failure is a real failure.
  if ! STAGE="$stage" bash "$script"; then
    echo "::warning::$name failed once (likely fresh-route flap); retrying"
    # Clear any leftover local Alchemy state for this example so the retry is a
    # clean create (a half-finished first attempt can otherwise collide).
    exdir="examples/${script#examples/}"; exdir="examples/$(printf '%s' "$script" | cut -d/ -f2)"
    find "$exdir" -type d -name .alchemy -prune -exec rm -rf {} + 2>/dev/null || true
    sleep 8
    STAGE="$stage" bash "$script"
  fi
  echo "::endgroup::"
done

echo "✅ all isolated Think examples passed live personal-Cloudflare E2E"
