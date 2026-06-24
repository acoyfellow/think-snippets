# cli-sandbox-ground-truth

A Cloudflare Project Think agent that runs a real `cf` CLI **from inside a
codemode sandbox** and treats its stdout as the source of truth. Companion to
[`cli-http-ground-truth`](../cli-http-ground-truth) (the HTTP/RPC flavor).

## The CLI is real, not a fixture

`CliSandbox extends Think` wires `@cloudflare/think`'s `createExecuteTool(this)`,
which runs generated JavaScript inside an isolated dynamic Worker (a codemode
`DynamicWorkerExecutor` over the `worker_loaders` LOADER binding). A real `cf`
tool is exposed to that sandbox as `tools.cf({ command })`; it calls the live
Cloudflare API server-side, so the bound token never enters the sandbox while
the output is genuine account state.

## What it proves

The probe:

1. reads the **true account name directly from the Cloudflare API**,
2. has the agent run `tools.cf({ command: "account" })` inside the sandbox and
   return its stdout,
3. asserts the sandbox stdout carries the real account name (real execution
   against the real account),
4. negative control: a fabricated name is **not** present.

## Run

```sh
# from this directory
STAGE=local bash scripts/run-e2e.sh
```

Typechecks, deploys to your personal Cloudflare account (guarded), warms the
route, runs the probe, and destroys the Worker + Durable Object on exit. Binds
your personal `CLOUDFLARE_API_TOKEN` for the `cf` tool.

## Requirements

`@cloudflare/codemode` (the execute tool / `CodemodeRuntime`) and the
`worker_loaders` LOADER binding, both wired in `alchemy.run.ts`.
