# rpc-chat-memory

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Isolated, self-contained example. A tiny Worker bridges native HTTP requests to
`Think.chat()` over Durable Object RPC and the live probe proves that streamed
RPC turns persist a session fact across independent requests.

## What it proves

`POST /chat/:sessionId` forwards the user message to a `Memory extends Think`
Durable Object via `Think.chat()`, consumes the streamed `text-delta` events
into a single answer, and returns JSON. The probe then:

1. Sends turn 1: *"Remember this exact fact: my calibration word is octarine."*
2. Sends turn 2 (a separate HTTP request): *"What is my calibration word?"*
3. Asserts turn 2's answer contains `octarine`.

A pass means the streamed `Think.chat()` RPC bridge persisted the session fact
in DO SQLite across requests — i.e. the conversational memory survives
independent stateless edge fetches, not just one in-process call.

## Isolation

This example is fully self-contained inside `examples/rpc-chat-memory/`:

- `worker.ts` — its own `Memory extends Think` Durable Object and HTTP router.
- `alchemy.run.ts` — its own Alchemy app `rpc-chat-memory` deploying Worker
  `rpc-chat-memory-${STAGE}` with binding `Memory`. The personal-account guard
  (`CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`) is copied here
  rather than imported, so this example deploys and destroys on its own state.
- `personal-env.sh` — local copy of the safety rail that pins Cloudflare
  credentials to the personal account before invoking any subprocess.
- `probe.ts` — live attestation + the two-turn memory check.
- `run-e2e.sh` — typecheck → deploy → warmup → probe → destroy (always).
- `tsconfig.json` — local typecheck scope.

There is no local `package.json` or lockfile: dependencies (`@cloudflare/think`,
`agents`, `workers-ai-provider`, `alchemy`, `typescript`) are resolved from the
repository root `node_modules` via standard Node resolution; CLIs are invoked
through `npx`.

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
   - `health.example === "rpc-chat-memory"`
   - turn-two answer contains the turn-one calibration word,
5. always destroys the Worker + Durable Object on exit, including on failure.

`STAGE` defaults to `local`; override to deploy to a different alchemy stage:

```sh
STAGE=preview bash run-e2e.sh
```

## Requirements

- `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN` exported
  in the environment. The safety rail rejects any other Cloudflare credentials.
- Repository root `bun install` has been run, so `node_modules` is populated.
