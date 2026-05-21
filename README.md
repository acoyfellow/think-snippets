# think-snippets

Real, runnable [Cloudflare Project Think](https://developers.cloudflare.com/agents/api-reference/think/) on Workers. This first repo cut is intentionally small and verifiable: one native `Think` Durable Object Worker, two proofs, one guarded personal-account deploy lifecycle.

## What is proved live

| Example | Real Think API | Probe assertion |
|---|---|---|
| [`examples/chat-rpc`](examples/chat-rpc) | `Think.chat()` RPC streaming | two requests to the same DO session recall `octarine` |
| [`examples/durable-submit`](examples/durable-submit) | `submitMessages()` + `inspectSubmission()` | a durable server-driven turn is accepted then reaches `completed` |

Both are implemented directly in [`src/worker.ts`](src/worker.ts), not through Flue or a mock transport. Workers AI uses `@cf/moonshotai/kimi-k2.6`; the Think DO is SQLite-backed.

## Personal Cloudflare safety rail

Cloudflare commands in this repo go through [`scripts/personal-env.sh`](scripts/personal-env.sh). It forcibly maps:

```sh
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
```

[`alchemy.run.ts`](alchemy.run.ts) then hard-fails unless the deploy account equals `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. The live `/health` result also attests that equality was true at deploy time, and the E2E probe refuses to continue otherwise.

## Run the proof

```sh
bun install
bun run e2e
```

That command:

1. typechecks,
2. deploys only through the personal-account wrapper,
3. curls the live `*.workers.dev` Worker,
4. proves Think conversational persistence,
5. proves durable programmatic submission completion,
6. destroys Worker + Durable Object resources on exit.

## Pinning / factual basis

This repo pins the API set verified during authoring: `@cloudflare/think@0.6.1`, `agents@0.12.4`, `ai@6.0.175`, `workers-ai-provider@3.1.14`. Cloudflare docs describe Think as an opinionated chat agent base class with DO SQLite persistence and document both chat/sub-agent flows and durable submissions in the May 2026 changelog.

## Next expansion surface

Workspace tools, context-backed sessions, browser/codemode tools, extensions, client chat UI, and richer sub-agent orchestration belong here, but this first push deliberately only claims what its live probe proves.
