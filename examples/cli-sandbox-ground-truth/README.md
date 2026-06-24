# cli-sandbox-ground-truth

A Cloudflare Project Think agent that runs the user's **CLI inside a sandbox**
and treats its stdout as the source of truth for doing tasks. Companion to
[`cli-http-ground-truth`](../cli-http-ground-truth) (the HTTP/RPC flavor).

## What it proves

`CliSandbox extends Think` wires `@cloudflare/think`'s `createExecuteTool(this)`,
which routes generated JavaScript into an isolated dynamic Worker (a codemode
`DynamicWorkerExecutor` over the `worker_loaders` LOADER binding). The "CLI" is a
small JS program executed in that sandbox; its stdout is a deterministic
transform of the per-run argument that only resolves by actually running.

The probe:

1. checks `/health` (personal-account guard + LOADER bound),
2. `POST /cli/:session { arg }` runs the CLI in the sandbox and returns stdout,
3. recomputes the same transform locally and asserts the sandbox stdout matches
   (proof of real execution), and
4. asserts a deliberately wrong argument would **not** match (proof the value is
   input-bound ground truth, not free-form).

## Run

```sh
# from this directory
STAGE=local bash scripts/run-e2e.sh
```

Typechecks, deploys to your personal Cloudflare account (guarded), warms the
route, runs the probe, and destroys the Worker + Durable Object on exit.

## Adapting it to a real CLI

Swap `cliProgramSource()` for code that invokes your real CLI/tooling inside the
sandbox (or expose your CLI as tools the sandbox can call). The contract holds:
the agent's task answer is whatever the CLI actually emitted.

## Requirements

`@cloudflare/codemode` (the execute tool / `CodemodeRuntime`) and the
`worker_loaders` LOADER binding, both wired in `alchemy.run.ts`.
