# effect-hello

Isolated, self-contained example. A Think DO whose custom tool body is an Effect program. One chat turn asks the model to greet a name; the Effect-backed `greet` tool runs inside the DO and the deterministic greeting reaches the assistant's final answer.

## What it proves

A Think tool's `execute` function can run an `Effect.gen(...)` block. The Effect program has its own typed errors, timeouts, and (if you scale this up) the full Effect composition surface — without changing how Think registers or invokes tools. The only seam between Think and Effect is one call:

```ts
execute: async ({ name }) => {
  const greeting = await Effect.runPromise(greetEffect(name));
  return { greeting };
}
```

The probe sends `"Please greet Octarine using the greet tool."` and asserts the response contains both `"octarine"` (the target name from the tool input) and `"think + effect"` (the deterministic string baked into the Effect program). A pass proves the Effect body actually ran and its output propagated through Think's tool-call → assistant-answer pipeline.

## Isolation

This example is fully self-contained inside `examples/effect-hello/`:

- `worker.ts` — `Greeter extends Think` with one Effect-backed tool.
- `alchemy.run.ts` — isolated Alchemy app `think-effect-hello`.
- `personal-env.sh` — local copy of the personal-account safety rail.
- `probe.ts` — one-turn chat assertion.
- `run-e2e.sh` — typecheck → deploy → warmup → probe → destroy.
- `tsconfig.json` — local typecheck scope.

Dependencies (`@cloudflare/think`, `agents`, `workers-ai-provider`, `ai`, `zod`, `effect`, `alchemy`) resolve from the repo root via standard Node resolution.

## Deploy / E2E

```sh
# from this directory
bash run-e2e.sh
```

`run-e2e.sh`:

1. typechecks this example only,
2. deploys to the personal Cloudflare account through `personal-env.sh`,
3. polls `*.workers.dev/health` until live,
4. runs `probe.ts` (requires `health.deployAccountMatchesExpected === true`, the target name in the answer, and the Effect program's literal string in the answer),
5. always destroys the Worker + Durable Object on exit.

## Requirements

- `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN` exported.
- Repository root `bun install` has been run.

## What real Effect agents look like

This example is the smallest possible *composition* of the two systems. For a fuller demonstration of what Effect brings to agent code — bounded concurrency, retry, streaming, approval flows, typed errors, MCP — see [acoyfellow/effect-agents](https://github.com/acoyfellow/effect-agents).
