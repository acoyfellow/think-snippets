# examples/workspace-write-read-proof

Live proof that Project Think's built-in **workspace tools** really write to a durable DO-backed filesystem — not just into the model's response text.

## What is proved

1. The `WorkspaceAssistant` Durable Object extends `Think`. Think auto-merges `createWorkspaceTools(this.workspace)` (`read`, `write`, `edit`, `list`, `find`, `grep`, `delete`) into every chat turn, backed by `@cloudflare/shell` `Workspace` on the DO's own SQLite storage.
2. The probe sends one chat turn instructing the model to call the `write` tool with a probe-controlled path (`/notes/proof.txt`) and probe-controlled content containing a fresh per-run nonce marker.
3. The probe then calls two **separate** Worker endpoints that bypass the model entirely:
   - `GET /inspect/:session/file?path=/notes/proof.txt` invokes a plain DO RPC method that calls `this.workspace.readFile(path)` directly.
   - `GET /inspect/:session/list?dir=/notes` invokes `this.workspace.readDir(dir)`.
4. The probe asserts the durable bytes contain the run-unique marker and that `proof.txt` appears as a real file entry under `/notes`.

This avoids prompt-leak-only proof: the model could parrot the marker in its streamed text without writing anything, and the test would still fail because the inspection RPC reads the actual durable filesystem.

## Files

| File | Role |
|---|---|
| `worker.ts` | Isolated Worker + `WorkspaceAssistant` DO with `inspectFile()` / `inspectList()` RPC. |
| `alchemy.run.ts` | Separate alchemy app (`think-snippets-workspace`) with the personal-account guard. |
| `probe.ts` | Drives chat → workspace `write` → durable inspection → assertions. |
| `run-e2e.sh` | Typecheck → personal deploy → warmup → probe → destroy on exit. |

## Personal Cloudflare safety rail

Same contract as the top-level repo. `alchemy.run.ts` here hard-fails unless `CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`, and the live `/health` endpoint attests that equality. Deploy and destroy go through `../../scripts/personal-env.sh`.

## Run the proof

From the repo root:

```sh
bun install
examples/workspace-write-read-proof/run-e2e.sh
```

Required environment:

- `CLOUDFLARE_PERSONAL_ACCOUNT_ID`
- `CLOUDFLARE_PERSONAL_API_TOKEN`

The script deploys this example only, exercises the live `*.workers.dev` URL, and then destroys the example's Worker + Durable Object resources on exit (including on failure).

## Isolation note

Nothing in this example edits files outside `examples/workspace-write-read-proof/`. The example reuses `scripts/personal-env.sh` (the repo's personal-account guard) as a read-only executable contract but does not modify it. The top-level `alchemy.run.ts`, `src/worker.ts`, `scripts/run-e2e.sh`, and `scripts/probe.ts` are untouched.
