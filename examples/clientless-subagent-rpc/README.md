# clientless-subagent-rpc

Isolated, self-contained example. A parent `Agent` invokes a child `Think`
sub-agent over **raw Durable Object RPC** — no React, no chat UI, no SSE, no
`agentTool` wrapping. The live probe asserts the three things the documented
sub-agent RPC contract is supposed to guarantee.

## What it proves

The Worker hosts two Durable Object classes:

- `Parent extends Agent` — the parent agent. Exposes a single RPC method,
  `delegate(childSessionId, userMessage)`, which:
  1. resolves the child by name via `getAgentByName(env.Child, childSessionId)`,
  2. invokes `child.chat(userMessage, callback)` where `callback` is a plain
     object satisfying Think's `StreamCallback` contract,
  3. counts every `onEvent` chunk and accumulates `text-delta` deltas into a
     single answer string,
  4. reads `child.getMessages()` to report how many messages the child has
     durably persisted,
  5. returns `{ parent, child, streaming, answer }` to the caller.
- `Child extends Think` — the sub-agent. Each unique `childSessionId` maps to
  its own DO instance with its own SQLite-backed conversation history. The
  system prompt is deliberately conservative: when asked to recall a fact it
  has never been told, it must answer literally `unknown`.

The probe does four checks:

1. **Streamed child output.** `delegate(childA, "remember octarine")` returns
   `streaming.chunkCount > 0` and `streaming.textDeltaCount > 0`, proving the
   parent observed real streamed deltas across the RPC boundary — not a single
   blocking call with a final blob.
2. **Child durable state.** `delegate(childA, "recall it")` recalls `octarine`
   and `child.messageCount` is strictly larger than after turn 1, proving the
   child's DO SQLite persisted state across two independent raw-RPC turns.
3. **Child isolation.** `delegate(childB, "recall it")` does **not** contain
   `octarine`. A different child session name resolves to a different DO
   instance with independent storage; the parent has no way to leak state
   between them.
4. **Direct DO read-through.** `GET /child/:childSessionId` calls
   `child.getMessages()` directly and confirms that A and B have different
   message counts (A holds the full conversation, B holds only the lookup
   turn).

## Why not `agentTool`?

The `agents`/`@cloudflare/think` SDKs include a higher-level convenience that
wraps a child as an AI-SDK tool the LLM can call from a parent's tool loop —
that's the "agents-as-tools" UI surface and deserves its own example. This
example is intentionally one level below: the parent calls the child directly
in handwritten code, observing the raw `StreamCallback` contract, so the
streaming, persistence, and isolation guarantees can be asserted without an
LLM tool-routing layer in the middle.

## HTTP surface

`POST /delegate/:parentId` — body `{ childSessionId, message }`. Routes the
turn through the parent's `delegate()` RPC method. Returns:

```json
{
  "ok": true,
  "parent":    { "id": "parent-..." },
  "child":     { "sessionId": "...", "messageCount": 4 },
  "streaming": { "chunkCount": 17, "textDeltaCount": 12 },
  "answer":    "octarine"
}
```

`GET /child/:childSessionId` — direct read of the child's durable message
count, used by the probe for an isolation cross-check.

`GET /health` — personal-account attestation, identical pattern to the
repository's other examples.

## Isolation (file layout)

This example is fully self-contained inside
`examples/clientless-subagent-rpc/`:

- `worker.ts` — its own `Parent extends Agent` and `Child extends Think` DOs,
  plus a small HTTP router.
- `alchemy.run.ts` — its own Alchemy app `clientless-subagent-rpc` deploying
  Worker `clientless-subagent-rpc-${STAGE}` with bindings `Parent` and
  `Child`. The personal-account guard
  (`CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`) is duplicated
  here rather than imported, so the example deploys and destroys on its own
  state.
- `personal-env.sh` — local copy of the safety rail that pins Cloudflare
  credentials to the personal account before invoking any subprocess.
- `probe.ts` — live attestation + the four streaming / persistence /
  isolation checks above.
- `run-e2e.sh` — typecheck → deploy → warmup → probe → destroy (always).
- `tsconfig.json` — local typecheck scope.

There is no local `package.json` or lockfile: dependencies
(`@cloudflare/think`, `agents`, `workers-ai-provider`, `alchemy`,
`typescript`) are resolved from the repository root `node_modules` via
standard Node resolution; CLIs are invoked through `npx`.

## Deploy / E2E semantics

```sh
# from this directory
bash run-e2e.sh
```

`run-e2e.sh`:

1. typechecks only this example,
2. deploys to the personal Cloudflare account through `personal-env.sh`,
3. polls `*.workers.dev/health` until it responds (≤ 90s),
4. runs `probe.ts`, which requires:
   - `health.deployAccountMatchesExpected === true`
   - `health.example === "clientless-subagent-rpc"`
   - streamed child chunk counts > 0,
   - calibration word recalled by child A across two raw-RPC turns,
   - calibration word **not** recalled by child B,
   - direct DO `messageCount` differs between A and B,
5. always destroys the Worker + Durable Objects on exit, including on
   failure.

`STAGE` defaults to `local`; override to deploy to a different alchemy stage:

```sh
STAGE=preview bash run-e2e.sh
```

## Requirements

- `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN`
  exported in the environment. The safety rail rejects any other Cloudflare
  credentials.
- Repository root `bun install` has been run, so `node_modules` is populated.
