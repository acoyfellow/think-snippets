# stream-resume-contract

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Live proof that the `@cloudflare/think` stream-resumption protocol survives a
mid-turn websocket disconnect on a real Cloudflare Worker, using only the
public `cf_agent_chat_*` wire protocol.

This example is fully isolated: its own worker entrypoint
([`worker.ts`](worker.ts)), its own alchemy app + stage
([`alchemy.run.ts`](alchemy.run.ts)), its own Think Durable Object
subclass (`StreamResumeAssistant`), and its own deploy/probe/destroy
script ([`run.sh`](run.sh)). It does not touch `src/worker.ts`,
`alchemy.run.ts`, or any other example.

## What is proved live

The probe ([`probe.ts`](probe.ts)) drives the actual websocket protocol with
no mock transport:

1. Opens websocket **A** to `/agents/stream-resume-assistant/<sessionId>`
   (the path `routeAgentRequest` exposes for the
   `StreamResumeAssistant extends Think` Durable Object) and sends a
   `cf_agent_use_chat_request` with a client-chosen `requestId` and a
   prompt that asks the model to print eight words, one per line, in
   order.
2. Reads `cf_agent_use_chat_response` frames until at least one
   `text-delta` chunk has arrived, **forcibly closes** websocket A
   mid-turn, and waits for the close to actually land.
3. Opens websocket **B** to the same DO, sends
   `cf_agent_stream_resume_request` followed immediately by
   `cf_agent_stream_resume_ack` carrying the original `requestId`.
4. Collects every replayed `cf_agent_use_chat_response` chunk until the
   final `done: true` frame for that `requestId`.
5. Decodes the recovered text-delta bodies and asserts the answer
   contains every requested word.
6. GETs `/agents/stream-resume-assistant/<sessionId>/get-messages` (the
   path Think wires through `onRequest`) and asserts the persisted
   assistant message also contains every requested word — proving
   recovery did not just stream chunks but also persisted the recovered
   assistant turn into Session-backed SQLite.

The probe accepts either of Think's two real recovery paths:

| Server reply to `stream-resume-request` | Recovery path the probe verifies |
|---|---|
| `cf_agent_stream_resuming { id }` | `ResumableStream.replayChunks()` replays the buffer and continues streaming the live in-flight turn |
| `cf_agent_stream_resume_none` | `ResumableStream.replayCompletedChunksByRequestId()` replays every persisted chunk for the original `requestId` |

Both paths are part of the public protocol surface in
`@cloudflare/think@0.6.1` /
[`agents@0.12.4 /chat`](../../node_modules/agents/dist/chat/index.d.ts);
the probe asserts that at least one of them fired and that the resulting
text reconstructs the full requested answer either way.

## Personal-account guard (isolated)

The example never depends on the root `alchemy.run.ts`. It re-applies
the same personal-account rail:

- [`alchemy.run.ts`](alchemy.run.ts) refuses to run unless
  `CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`.
- The Worker exposes `/health` with a `deployAccountMatchesExpected`
  attestation reading both env bindings at request time.
- [`run.sh`](run.sh) routes every Cloudflare-affecting command through
  the existing [`scripts/personal-env.sh`](../../scripts/personal-env.sh)
  wrapper, deploys with its own stage (default
  `STAGE=stream-resume-contract`), and `trap`s `EXIT|INT|TERM` to
  `alchemy destroy` the isolated app on the personal account regardless
  of probe outcome.
- The probe refuses to drive a turn if `/health` does not attest the
  personal account match.

## Run live

```sh
bash examples/stream-resume-contract/run.sh
```

Requires the same env the rest of the repo requires:

- `CLOUDFLARE_PERSONAL_ACCOUNT_ID`
- `CLOUDFLARE_PERSONAL_API_TOKEN`

The script:

1. enforces the personal-account env guard,
2. deploys only through the personal-account wrapper into an isolated
   alchemy app + stage,
3. warms `/health` until the route is live,
4. runs `probe.ts` against the live `*.workers.dev` URL,
5. destroys the isolated Worker + Durable Object resources on exit.

Nothing about this example is shared with the other proofs, so failures
or partial runs cannot pollute the main `chat-rpc` or `durable-submit`
deployments.

## Sources of the wire contract used here

Reading the actual implementation of `@cloudflare/think@0.6.1` confirmed
every message used by this example:

- WS prefix: `routeAgentRequest` registers the `agents` prefix and
  routes `/agents/<kebab-class>/<name>` to the corresponding Durable
  Object — see `agents/dist/index.js` and `partyserver/dist/index.js`.
- Wire types: `CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST`,
  `USE_CHAT_RESPONSE`, `STREAM_RESUME_REQUEST`, `STREAM_RESUMING`,
  `STREAM_RESUME_NONE`, `STREAM_RESUME_ACK` — see
  `agents/dist/chat/index.d.ts`.
- Resume dispatch:
  `_handleStreamResumeRequest` / `_handleStreamResumeAck` /
  `_notifyStreamResuming` / `ResumableStream.replayChunks` /
  `ResumableStream.replayCompletedChunksByRequestId` — see
  `@cloudflare/think/dist/think.js` and `agents/dist/chat/index.js`.
- HTTP `get-messages` route: `Think` wraps `onRequest` and serves
  `/get-messages` (or any path ending in `/get-messages`) — see
  `@cloudflare/think/dist/think.js`.
