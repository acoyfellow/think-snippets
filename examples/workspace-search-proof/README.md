# workspace-search-proof

Isolated, fully destroyable proof that Cloudflare [Project Think](https://developers.cloudflare.com/agents/api-reference/think/) actually invokes its workspace tools (`list` / `find` / `grep` / `read`) to answer a question — not just lucks into the right text.

This example is self-contained: its own worker, its own `alchemy.run.ts`, its own personal-account guard, its own probe, its own teardown. **It does not modify any shared file in the repo** and deploys as a separate Alchemy app (`think-snippets-workspace-search`).

## What is proved live

| Step | Mechanism | Assertion |
|---|---|---|
| Deploy account guard | `scripts/personal-env.sh` + `alchemy.run.ts` refuse to deploy unless `CLOUDFLARE_ACCOUNT_ID == CLOUDFLARE_PERSONAL_ACCOUNT_ID` | `/health` reports `deployAccountMatchesExpected: true` |
| Seeding | `POST /seed/:sessionId` → DO RPC `seedFiles()` → `Workspace.writeFile()` | Returns the list of paths written |
| Forced tool use | `WorkspaceAssistant.getTools()` returns `createWorkspaceTools(this.workspace)` and the system prompt mandates list+find/grep + read before answering | Model produces only the unique fact value |
| Durable evidence log | `WorkspaceAssistant.afterToolCall()` records `{tool, input, output, success, durationMs}` into a private SQLite `tool_log` table on the Think DO | Probe asserts ≥1 successful `list`/`find`/`grep` call **and** ≥1 successful `read` of the file that holds the fact |

Because `afterToolCall` is wired through the AI SDK's `experimental_onToolCallFinish`, the model cannot bypass it — every server-side tool call is recorded with its real wall-clock `durationMs` and discriminated success/error outcome.

## Source

- Worker: [`src/worker.ts`](src/worker.ts)
- Alchemy app (isolated): [`alchemy.run.ts`](alchemy.run.ts)
- Personal-account guard: [`scripts/personal-env.sh`](scripts/personal-env.sh)
- Probe (seed → ask → assert evidence): [`scripts/probe.ts`](scripts/probe.ts)
- E2E with teardown trap: [`scripts/run-e2e.sh`](scripts/run-e2e.sh)

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Account-equality attestation |
| `POST` | `/seed/:sessionId` | `{ files: [{ path, content }] }` → writes files into the DO's workspace via RPC |
| `POST` | `/chat/:sessionId` | `{ message }` → runs `Think.chat()`, returns final `answer` |
| `GET`  | `/tools/:sessionId?afterSeq=N` | Returns the durable tool-call log for that session DO |
| `POST` | `/reset/:sessionId` | Clears `tool_log`, workspace contents (best-effort), and chat history |

## Run the proof

```sh
CLOUDFLARE_PERSONAL_ACCOUNT_ID=… CLOUDFLARE_PERSONAL_API_TOKEN=… \
  bash examples/workspace-search-proof/scripts/run-e2e.sh
```

That script:

1. Typechecks the example in isolation (`tsc --noEmit -p tsconfig.json`).
2. Deploys only via the personal-account wrapper.
3. Waits for `/health` to come live on the deployed `*.workers.dev` host.
4. Runs `scripts/probe.ts`, which:
   - resets the session,
   - seeds 6 plausible files with a unique random calibration tag hidden in exactly one,
   - asks Think to locate the tag,
   - verifies the model's answer contains the tag AND the durable `tool_log` shows a real search + a real read of the correct file,
5. Destroys all Alchemy-managed resources on exit (including failure / Ctrl-C, via `trap`).

## Why this is not "answer luck"

The unique fact is a fresh `octarine-<8-char-uuid>` string regenerated per probe run, hidden in one of six files. The model cannot have memorized it. The probe asserts on the durable tool-log table, not the answer text alone — so even if a future model happened to echo the literal value back without searching, the assertion would still fail because `list`/`find`/`grep` + `read(/projects/discworld/colors.md)` would not appear in `tool_log`.
