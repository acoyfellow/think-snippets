# concurrency-latest-vs-queue

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Two `Think` Durable Objects with identical configuration except their
`messageConcurrency` mode:

- `QueueAssistant` → `"queue"` — every overlapping `submit-message` runs in
  arrival order.
- `LatestAssistant` → `"latest"` — when a newer overlapping submit arrives,
  earlier still-queued submits are superseded and complete with an empty
  terminal frame; their assistant response is never persisted.

This example is **fully isolated**: its own [`alchemy.run.ts`](./alchemy.run.ts),
its own [`worker.ts`](./worker.ts), its own [`tsconfig.json`](./tsconfig.json),
its own [`probe.ts`](./probe.ts), and its own [`run.sh`](./run.sh). It does not
edit `src/worker.ts`, `alchemy.run.ts`, `scripts/*`, or `tsconfig.json` in the
parent repo. The personal-account guard is reused (not modified) by *invoking*
`../../scripts/personal-env.sh`.

## What this proves live

The probe drives the agent's WebSocket chat protocol (`cf_agent_use_chat_*`)
directly from Bun — that is the only path `Think#messageConcurrency` affects
(`Think.chat()` RPC and `submitMessages()` are always serial through
`_turnQueue.enqueue`).

For each variant the probe sends **three** chat requests A, B, C in quick
succession with a server-side per-turn delay enforced inside `beforeTurn`. It
then verifies, against the receipts (terminal `cf_agent_use_chat_response`
frames) and the persisted history:

| Variant | User msgs persisted | Assistant msgs persisted | Empty terminal frames | Which submit is superseded |
|---|---|---|---|---|
| `queue`  | 3 | 3 | 0 | — |
| `latest` | 3 | 2 | 1 | the **middle** (B) |

Both are deterministic observable invariants:

- **All three user messages persist either way.** Think reconciles and persists
  incoming user messages *before* the supersede gate fires
  (`Think._handleChatRequest`, around `node_modules/@cloudflare/think/dist/think.js`
  L1959–L1965).
- **The first overlapping submit is never superseded.**
  `SubmitConcurrencyController.decide()` returns `submitSequence: null` when
  `queuedTurnsInCurrentEpoch === 0` (the very first one), so `isSuperseded`
  cannot fire for it (`node_modules/agents/dist/chat/index.js` L336–L343,
  L391–L393). That is why two submits are not enough to observe the
  difference; we send three.
- **The middle submit is superseded.** When C arrives while A is running and
  B is queued, `_latestOverlappingSubmitSequence` advances to 2 and B's
  `submitSequence=1` becomes stale. B's task body calls
  `_completeSkippedRequest`, which emits the empty terminal frame and persists
  no assistant message.

## How timing flakiness is avoided

The supersede observation is **not** a race against the model's own latency.
A controllable hook — `beforeTurn` — sleeps for `turnDelayMs` (5s in the
probe) before any model work runs:

```ts
override async beforeTurn(ctx: TurnContext): Promise<void> {
  const raw = ctx.body?.turnDelayMs;
  const next = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  if (next > 0) await new Promise((resolve) => setTimeout(resolve, next));
}
```

The probe sends submits 200 ms apart; all three are admitted and queued well
before A's first turn finishes. The probe asserts on receipts and history, not
on wall-clock timing.

A second controllable mechanism — the `slow` tool — is also wired in so a
future variant of this example can force the delay to occur *inside the model
loop* if needed. The probe does not depend on the model choosing to call it.

## Inspectable receipts / results

Every WebSocket request id appears in `probe.ts`'s per-receipt capture. The
terminator frame (`done: true`) is emitted in BOTH the streamed and the
superseded case; what distinguishes them is whether the protocol emitted any
content chunks (`done: false` frames carrying `text-delta` payloads) before it.
Recorded shape, from an actual live run:

```
{
  "variant": "latest",
  "submittedRequestIds": ["<a-uuid>", "<b-uuid>", "<c-uuid>"],
  "receipts": [
    { "requestId": "<a-uuid>", "contentChunks": 38,  "streamedTextPreview": "done A", "done": true },
    { "requestId": "<b-uuid>", "contentChunks": 0,   "streamedTextPreview": "",       "done": true },
    { "requestId": "<c-uuid>", "contentChunks": 863, "streamedTextPreview": "done C", "done": true }
  ],
  "userCount": 3,
  "assistantCount": 2
}
```

In the queue variant the analogous capture has non-zero `contentChunks` for
all three receipts and `assistantCount: 3`. The persisted history is queryable
from outside the probe via `GET /history/:variant/:session` (the example's
Worker exposes it for live inspection).

## Personal-account safety rail (reused, not modified)

Cloudflare commands route through `../../scripts/personal-env.sh`, the same
guard the parent repo uses. The example's own `alchemy.run.ts` then hard-fails
unless `CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`, and the
live `/health` endpoint attests that equality at deploy time. The probe
refuses to run otherwise.

## Run the proof

```sh
# from repo root
bash examples/concurrency-latest-vs-queue/run.sh
```

That command:

1. typechecks just this example,
2. deploys an isolated alchemy app (`concurrency-latest-vs-queue`) through the
   personal-account wrapper,
3. drives both variants with three concurrent submits each over the live
   WebSocket chat protocol,
4. asserts the deterministic queue-vs-latest invariants above,
5. destroys the isolated Worker + Durable Object resources on exit.

The default stage is `concurrency-personal` to keep state separate from the
parent `local`/`personal` stages.

## Caveats

- **WebSocket-only.** `Think.messageConcurrency` does not affect
  `Think.chat()` RPC or `submitMessages()`; both are always sequential
  through `_turnQueue`. The example uses the WebSocket protocol because that
  is the only path where the setting has an observable effect.
- **Three submits, not two.** The first overlapping submit's `submitSequence`
  is `null` (see decide()'s early return), so a two-submit test cannot show
  supersession. We need at least three submits in flight to observe the
  middle one being skipped.
- **Per-instance personal Cloudflare.** This example requires
  `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN` in the
  environment, like the parent repo.
- **Workers AI cold start.** The probe's 60 s ws-frame timeout and `route
  warmup` step in `run.sh` cover the first deploy's cold start, but a heavily
  oversubscribed `@cf/moonshotai/kimi-k2.6` could in principle exceed 60 s
  end-to-end. If that happens repeatedly, increase `TURN_DELAY_MS` and the WS
  timeout proportionally.
- **No commits.** This example is added on the worktree only; nothing is
  committed.
