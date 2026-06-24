# think-snippets

Small, live-proven [Cloudflare Project Think](https://developers.cloudflare.com/agents/api-reference/think/) contracts. This repo intentionally does **not** compete with Cloudflare's full assistant, submissions dashboard, or agent-tools showcase. It collects the lower-level seams builders trip over: RPC initialization, durable filesystem evidence, hook ordering, cross-agent handoff, protocol broadcast/resume, and concurrency behavior.

Every isolated example has its own Worker, Durable Object bindings, [Alchemy](https://alchemy.run) deploy file, probe, cleanup trap, and README. Local E2E scripts force `CLOUDFLARE_PERSONAL_*` credentials, deploy to real Workers via Alchemy, assert live evidence, and destroy their resources on exit.

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets/tree/main/examples/rpc-chat-memory)

One example — [`rpc-chat-memory`](examples/rpc-chat-memory) — ships a `wrangler.jsonc` so the **Deploy to Cloudflare** button can spin it up on your account in a click. The other 15 deploy via Alchemy under the personal-account guard and are not button-deployable; use [Run everything](#run-everything) for those.

- Source: <https://github.com/acoyfellow/think-snippets>
- Public landing target: <https://think.coey.dev>
- Public showcase: <https://think.coey.dev>

## The example set

| Example | Gap it fills | Live proof |
|---|---|---|
| [`rpc-chat-memory`](examples/rpc-chat-memory) | Headless HTTP → `Think.chat()` RPC | turn 2 recalls the unique fact from turn 1 |
| [`workspace-write-read-proof`](examples/workspace-write-read-proof) | Prompt text is not storage proof | Think `write` tool creates bytes that direct Workspace RPC reads back |
| [`workspace-search-proof`](examples/workspace-search-proof) | Search grounding, not answer luck | tool log records list/find/read before the hidden fact answer |
| [`server-tool-audit-loop`](examples/server-tool-audit-loop) | Tool output provenance | durable audit row + response both contain runtime-only output |
| [`effect-hello`](examples/effect-hello) | Effect v4 inside a Think tool | one chat turn drives an Effect-backed tool; deterministic greeting reaches the assistant answer |
| [`tool-approval-headless`](examples/tool-approval-headless) | Approval without a chat UI | denied/no-ticket/approved/replay branches prove exactly-once side effect behavior |
| [`hook-order-receipt`](examples/hook-order-receipt) | Hook semantics people hand-wave | durable receipt proves the stable partial ordering of Think turn hooks |
| [`clientless-subagent-rpc`](examples/clientless-subagent-rpc) | Raw child Think invocation, not agent-tools UI | parent streams child output; child sessions persist and stay isolated |
| [`cross-agent-handoff-envelope`](examples/cross-agent-handoff-envelope) | Machine-readable handoff | typed envelope + checksum + producer/consumer durable evidence |
| [`scheduled-synthetic-turn`](examples/scheduled-synthetic-turn) | Server-triggered Think turns | `schedule()` fires, injects a synthetic user turn, persists the reply |
| [`execute-tool-state-edit`](examples/execute-tool-state-edit) | Execute tool state mutation | sandboxed JS writes workspace state; parent DO reads it directly |
| [`concurrency-latest-vs-queue`](examples/concurrency-latest-vs-queue) | `messageConcurrency` semantics | WebSocket receipts show queue keeps all turns while latest supersedes the middle turn |
| [`multi-tab-broadcast-protocol`](examples/multi-tab-broadcast-protocol) | Broadcast protocol without building a UI | two websocket clients receive the same streamed request id |
| [`stream-resume-contract`](examples/stream-resume-contract) | Resume/replay at the wire level | disconnect, reconnect, resume/replay chunks, persisted assistant transcript agrees |
| [`cli-http-ground-truth`](examples/cli-http-ground-truth) | Agent uses an external CLI (over HTTP) as ground truth | answer carries the CLI's runtime-only stdout token; durable audit row proves the tool shelled out |
| [`cli-sandbox-ground-truth`](examples/cli-sandbox-ground-truth) | Agent uses a sandbox CLI as ground truth | a deterministic CLI runs in a codemode sandbox; output is genuinely computed in-sandbox from the input |

Two early repo-root smoke surfaces remain in [`src/worker.ts`](src/worker.ts): native chat RPC and durable `submitMessages()` status polling. The richer examples above are the maintainable contract library.

## Run everything

```sh
bun install
bun run check
bun run e2e:examples
```

`bun run e2e:examples` runs the 16 isolated live tests sequentially. Each child deploys only to your personal Cloudflare account, probes real Workers AI / Think / Durable Object behavior, and tears itself down. Single-example READMEs show their direct script.

Required local env:

```sh
CLOUDFLARE_PERSONAL_ACCOUNT_ID=...
CLOUDFLARE_PERSONAL_API_TOKEN=...
```

The wrapper maps those into the ordinary `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair immediately before Cloudflare commands. Example Alchemy files also refuse to deploy if the two account IDs differ.

## Personal Cloudflare safety rail

Cloudflare commands in this repo go through [`scripts/personal-env.sh`](scripts/personal-env.sh):

```sh
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
```

Each live `/health` response attests that account equality was true at deploy time; probes reject a deploy that cannot attest this.

## Version truth

The repo pins the stack it verifies (refreshed 2026-06):

- `@cloudflare/think@0.10.0`
- `@cloudflare/shell@0.4.0`
- `agents@0.16.2`
- `ai@6.0.209`
- `workers-ai-provider@3.2.0`
- `zod@4.4.3`
- `@cloudflare/codemode@0.4.1` for the execute / sandbox-CLI examples
- `alchemy@0.93.12`, `@cloudflare/workers-types@4.20260624.1`

This exact set matters. Notable migrations captured here: think@0.10's `chat()` `StreamCallback` now requires `onStart` and `onDone`; codemode@0.4 runs sandboxed code in a `CodemodeRuntime` Durable Object that must be exported from the worker entry, prefers the `createExecuteTool(this)` one-liner, and takes object args (`state.writeFile({ path, content })`).
