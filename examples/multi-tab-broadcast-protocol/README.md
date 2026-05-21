# multi-tab-broadcast-protocol

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Two headless WebSocket clients attach to one Project Think Durable Object using
the [agents](https://www.npmjs.com/package/agents) protocol. A single
`cf_agent_use_chat_request` from one client is fanned out as
`cf_agent_use_chat_response` deltas to *both* clients — the protocol-level proof
that "the same chat open in two tabs" stays in sync without any UI layer.

## What is proved live

| Behavior | How |
|---|---|
| `routeAgentRequest` upgrades `wss://<worker>/agents/assistant/<sessionId>` | [`src/worker.ts`](src/worker.ts) delegates to `routeAgentRequest` from `agents@0.12.4` |
| Two `AgentClient` sockets share one Think DO | Both connect with the same `name` (sessionId) |
| Think `_broadcastChat` reaches every connection | Only client A sends the chat request; client B still receives streamed `text-delta` chunks and a `done:true` terminator for the same `id` |

The probe asserts each tab received `cf_agent_use_chat_response` frames for the
issued request id, that both saw `done:true`, and that both accumulated
non-empty text deltas. No browser is involved — `AgentClient` runs in Bun
against a global `WebSocket`.

## Isolation

- Its own Worker class (`Assistant` in `examples/multi-tab-broadcast-protocol/src/worker.ts`).
- Its own Alchemy app name (`ts-mtb`, short to keep the
  `*.workers.dev` subdomain under Cloudflare's 63-char limit) and Worker name
  (`ts-mtb-<stage>`).
- Default stage is `multitab` to keep it separate from the root `local` stage.
- Its own personal-account wrapper at
  [`scripts/personal-env.sh`](scripts/personal-env.sh) so this example never
  reaches a non-personal Cloudflare account.

The repo-root `src/worker.ts` and `alchemy.run.ts` are not modified.

## Personal Cloudflare safety rail

[`alchemy.run.ts`](alchemy.run.ts) hard-fails unless
`CLOUDFLARE_ACCOUNT_ID == CLOUDFLARE_PERSONAL_ACCOUNT_ID`, identical to the
repo root contract. The live `/health` payload re-asserts that equality
post-deploy, and the probe refuses to continue otherwise.

## Run the proof

```sh
bun install
CLOUDFLARE_PERSONAL_ACCOUNT_ID=… \
CLOUDFLARE_PERSONAL_API_TOKEN=… \
bash examples/multi-tab-broadcast-protocol/scripts/run-e2e.sh
```

That command:

1. typechecks the whole repo (`bun run typecheck`),
2. deploys an isolated Worker + DO through the personal-account wrapper,
3. curls `/health` until the route is live and attests personal-account match,
4. runs [`scripts/probe.ts`](scripts/probe.ts) which opens two `AgentClient`
   WebSockets to the same `Assistant` instance, sends one
   `cf_agent_use_chat_request` from tab A, and asserts both tabs observe the
   streamed `cf_agent_use_chat_response`,
5. destroys Worker + Durable Object resources on exit via the `trap cleanup`
   block (runs even on failure / SIGINT / SIGTERM).

## Wire-level details

The `chat-request` frame sent by tab A is exactly what `parseProtocolMessage`
(from `agents/chat`) maps to a `chat-request` event for Think:

```json
{
  "type": "cf_agent_use_chat_request",
  "id": "<uuid>",
  "init": {
    "method": "POST",
    "body": "{\"messages\":[{ \"id\":\"…\", \"role\":\"user\", \"parts\":[{ \"type\":\"text\", \"text\":\"…\" }] }]}"
  }
}
```

Each response frame the tabs observe looks like:

```json
{ "type": "cf_agent_use_chat_response", "id": "<same uuid>", "body": "{\"type\":\"text-delta\",\"delta\":\"…\"}", "done": false }
```

with a final `done: true` terminator. This wire shape is documented by
`CHAT_MESSAGE_TYPES` in `agents/dist/chat/index.d.ts`.

## Pinning / factual basis

Pinned against `@cloudflare/think@0.6.1`, `agents@0.12.4`,
`workers-ai-provider@3.1.14`. Think's `_broadcastChat` (`think.js:2677`) calls
`this.broadcast(...)` on the underlying agents `PartyServer`, which is what
makes every attached WebSocket receive the streamed reply. The routing path
used by both clients is the default `/agents/{class-kebab}/{name}` shape that
`routeAgentRequest` recognizes.
