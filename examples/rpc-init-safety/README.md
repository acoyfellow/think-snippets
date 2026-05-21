# rpc-init-safety

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Exposes the real initialization seam in `@cloudflare/think` + `agents`:

- **Safe path:** `getAgentByName(env.RpcSafetyAssistant, sessionId)` awaits the
  Agents `onStart()` lifecycle hook before returning a stub, so custom RPC
  methods can rely on anything `onStart()` set up.
- **Unsafe path (recorded, not triggered live):** `env.RpcSafetyAssistant.get(
  env.RpcSafetyAssistant.idFromName(id))` returns a bare `DurableObjectStub`
  that does **not** await `onStart()`. Calling user RPC through it during a
  cold start can observe pre-`onStart()` state or throw, because PartyServer
  wiring has not finished.

## What the live probe asserts

| Step | Endpoint | Asserts |
|---|---|---|
| 1 | `GET /health` | Worker attests deploy account equals `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. |
| 2 | `GET /safe/:session/init` | A custom RPC reached through `getAgentByName()` sees the marker `onStart()` wrote to DO storage. |
| 3 | `GET /inspect/bare-rpc-hazard` | A documented JSON contract names the unsafe and safe seam patterns and points at the probe in step 2. |
| 4 | `POST /safe/:session/chat` | `Think.chat()` still works through the safe seam (smoke; conversational memory is proved in `examples/chat-rpc`, not duplicated here). |

The hazard endpoint is *documentation*, not a live re-enactment. Reproducing
the bare-RPC race condition cleanly requires very specific cold-start timing
and varies by `@cloudflare/think` / `agents` version, so wiring the E2E to
that crash would make the test flaky and would assert the wrong thing
("did we crash today?"). The E2E asserts the safe seam works and that the
unsafe contract is published.

## Source

- Worker: [`src/worker.ts`](src/worker.ts)
- Alchemy entrypoint (isolated app + personal-account guard): [`alchemy.run.ts`](alchemy.run.ts)
- Probe: [`scripts/probe.ts`](scripts/probe.ts)
- Live deploy / probe / destroy: [`scripts/run-e2e.sh`](scripts/run-e2e.sh)

## Run it

The example is fully isolated from the repo-root `think-snippets` app —
distinct Alchemy app name, distinct Worker name, distinct DO class, and its
own state directory under `examples/rpc-init-safety/.alchemy`.

```sh
# from the repo root
CLOUDFLARE_PERSONAL_ACCOUNT_ID=... CLOUDFLARE_PERSONAL_API_TOKEN=... \
  bash examples/rpc-init-safety/scripts/run-e2e.sh
```

That command typechecks, deploys this example only through the repo
`scripts/personal-env.sh` personal-account wrapper, runs the probe against
the live `*.workers.dev` URL, and always destroys the example's Worker +
Durable Object on exit.
