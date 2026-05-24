# hook-order-receipt

Proves that the `@cloudflare/think` lifecycle hooks fire in a **stable
partial order** during a deterministic, tool-invoking, durable turn — and
makes that order machine-verifiable by recording every hook invocation as
a sequenced row in a per-DO SQLite "receipt" table.

## What is proved live

A separate Worker + Durable Object is deployed for this example only
(`hook-order-receipt-<stage>`). The DO subclasses `Think` as
`OrderedAssistant`, registers exactly one server-side tool (`echo`), and
overrides every chat-turn lifecycle hook:

- `beforeTurn`
- `beforeStep` — also forces the `echo` tool on step 0 (deterministic)
- `beforeToolCall`
- `afterToolCall`
- `onStepFinish`
- `onChatResponse`

Each hook appends a row to `hook_order_receipt(seq, hook, step_number,
tool_call_id, tool_name, detail, recorded_at)`. `seq` is a monotonic
AUTOINCREMENT — it gives the probe a total order over hook invocations
*on the DO*, independent of wall-clock timing.

The turn is driven through `Think.submitMessages()` (durable
programmatic submission). The probe polls `inspectSubmission()` to
`completed`, fetches `GET /order/:sessionId/receipt`, and verifies the
following **stable** contract:

1. `beforeTurn` fires exactly once, before every other hook event.
2. `onChatResponse` fires exactly once, after every other hook event,
   with `status: "completed"`.
3. `beforeStep` count equals `onStepFinish` count (one of each per AI
   SDK step).
4. For every tool call, the `beforeToolCall` row's `seq` is strictly
   less than the matching `afterToolCall` row's `seq` (same
   `toolCallId`), and the tool name agrees.
5. The forced `echo` tool was actually invoked at least once.
6. The first `beforeStep` precedes the first `beforeToolCall`
   (tool calls nest inside steps).

### What is intentionally **not** asserted

- The exact interleaving between `onStepFinish` and `afterToolCall`
  across steps. The AI SDK pipeline does not promise a single canonical
  ordering between these in every path, so the Think public hook
  contract does not promise one either.
- The relative ordering of multiple `beforeStep` events when the model
  runs more than one step — only that each `beforeStep` has a matching
  `onStepFinish`.
- Anything about chunk-level interleaving (`onChunk` is high-frequency
  and is not recorded by this example, since recording it would
  dominate the receipt and produce no stable contract to assert).
- Any ordering involving `onChatRecovery` (this example does not
  exercise the recovery path).

This split is deliberate: the probe asserts only what the public hook
API promises today, so the probe stays green across non-breaking
internal changes inside Think.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Attests the deploy account equaled `CLOUDFLARE_PERSONAL_ACCOUNT_ID` at deploy time. |
| `POST` | `/order/:sessionId/run` | Clears the receipt, then `submitMessages()` a deterministic echo turn. |
| `GET`  | `/order/:sessionId/inspect/:submissionId` | `inspectSubmission()` passthrough — used to poll terminal status. |
| `GET`  | `/order/:sessionId/receipt` | Returns the ordered hook receipt rows for this DO. |

## Run the proof

```sh
bun install
bash examples/hook-order-receipt/run-e2e.sh
```

That script:

1. typechecks `examples/hook-order-receipt/` against its own `tsconfig.json`,
2. deploys **only this example** through `scripts/personal-env.sh`
   (hard-failing unless `CLOUDFLARE_ACCOUNT_ID` is your personal account),
3. curls the live `*.workers.dev` URL,
4. submits one durable tool-invoking turn,
5. polls until the submission reports `completed`,
6. fetches the hook receipt and verifies the stable partial-order contract,
7. destroys the example's Worker + DurableObject on exit.

The repo-level `bun run e2e` script is untouched and continues to deploy
only the shared `think-snippets` worker.

## Isolation guarantees

- Own Worker entrypoint: [`worker.ts`](worker.ts).
- Own alchemy app + Worker name + DurableObject namespace
  (`OrderedAssistant`): [`alchemy.run.ts`](alchemy.run.ts).
- Own probe: [`probe.ts`](probe.ts).
- Own E2E driver: [`run-e2e.sh`](run-e2e.sh).
- Own typecheck root: [`tsconfig.json`](tsconfig.json).
- Reuses the shared [`scripts/personal-env.sh`](../../scripts/personal-env.sh)
  safety rail without modifying it.
