# execute-tool-state-edit

Isolated, self-contained example. Lives entirely under
`examples/execute-tool-state-edit/`; does not import or modify any
shared file (`../../src/worker.ts`, `../../alchemy.run.ts`,
`../../scripts/`, `../../package.json`, `../../tsconfig.json` are all
untouched).

## What it proves live

`createExecuteTool` from `@cloudflare/think/tools/execute` (the
codemode-style sandboxed-JS tool) is wired up with
`createWorkspaceStateBackend(this.workspace)` from `@cloudflare/shell`,
so guest JavaScript executed inside the dynamic worker isolate can
mutate the parent `Think` Durable Object's workspace through `state.*`.

The probe deterministically asserts three things on the live `*.workers.dev`
Worker:

| Assertion | Mechanism |
|---|---|
| Sandboxed JS executes end-to-end and returns its own result | `tool.execute({ code }, …)` → `CodeOutput.result` |
| Sandboxed JS mutates Think workspace state and the parent DO sees the same bytes | guest calls `state.writeFile(path, marker)`, then `GET /state/:session/<path>` calls `this.workspace.readFile(path)` and returns `marker` |
| The sandbox is network-isolated by default | guest calls `fetch("https://example.com")`, the thrown error message is returned and checked |

The probe avoids the LLM-must-decide-to-call-a-tool flake by invoking
the execute tool's `execute()` function directly from a Worker RPC
route. The same `Assistant extends Think` DO would expose the same tool
to a real chat turn via `getTools()`.

## Required runtime binding

`createExecuteTool` requires a `worker_loaders` binding so its
`DynamicWorkerExecutor` can spin up an isolated dynamic Worker for each
run. This example's `alchemy.run.ts` adds it:

```ts
bindings: {
  …,
  LOADER: WorkerLoader(),
}
```

and the deployed Worker confirms the binding is present from
`/health`.

## Personal Cloudflare safety rail

Identical to the rest of this repo: `scripts/personal-env.sh` (a
verbatim local copy of `../../scripts/personal-env.sh`) forces the
following before invoking any Cloudflare command:

```sh
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
```

`alchemy.run.ts` then hard-fails unless
`CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`. The live
`/health` JSON also attests the same equality
(`deployAccountMatchesExpected: true`), and `scripts/probe.ts` refuses to
continue otherwise.

## Run the proof

From the repo root (after `bun install`):

```sh
export CLOUDFLARE_PERSONAL_ACCOUNT_ID=…
export CLOUDFLARE_PERSONAL_API_TOKEN=…
bash examples/execute-tool-state-edit/scripts/run-e2e.sh
```

That single command:

1. typechecks this example against its local `tsconfig.json`,
2. deploys this isolated example through the personal-account wrapper
   (`alchemy deploy --cwd examples/execute-tool-state-edit`),
3. waits for the live `*.workers.dev` Worker to respond on `/health`,
4. runs `scripts/probe.ts`, which proves sandboxed-JS execution,
   workspace-state mutation, and default network isolation,
5. always destroys the deployed Worker + Durable Object on exit via the
   `trap cleanup EXIT INT TERM` in `scripts/run-e2e.sh`.

Manual cleanup if the trap is bypassed:

```sh
bash examples/execute-tool-state-edit/scripts/personal-env.sh \
  npx alchemy destroy --cwd examples/execute-tool-state-edit --stage personal
```

## Pinned packages (verified at authoring time)

- `@cloudflare/think@0.6.1` (`./tools/execute` → `createExecuteTool`)
- `@cloudflare/codemode@0.3.7` (`DynamicWorkerExecutor`, transitive peer of `@cloudflare/think`'s `tools/execute`)
- `@cloudflare/shell@0.3.6` (`Workspace`, `createWorkspaceStateBackend`)
- `agents@0.12.4`, `ai@6.0.175`, `workers-ai-provider@3.1.14`
- `alchemy@0.93.7` (`WorkerLoader()` binding)

## Files in this example

```
examples/execute-tool-state-edit/
├── README.md
├── alchemy.run.ts               # self-contained deploy (worker_loaders + personal-account guard)
├── tsconfig.json                # local include set; root tsconfig is untouched
├── src/worker.ts                # Think DO + createExecuteTool + state backend + RPC routes
└── scripts/
    ├── personal-env.sh          # local copy of the personal-account wrapper
    ├── probe.ts                 # live evidence-collection script
    └── run-e2e.sh               # deploy → probe → destroy
```
