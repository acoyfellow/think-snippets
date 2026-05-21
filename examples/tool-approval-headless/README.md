# examples/tool-approval-headless

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

A live, headless proof of a **server-enforced approval flow for a Think-sensitive tool**. The sensitive tool only runs when a durable approval ticket says it can — and only **exactly once**. Every attempt is recorded in inspectable, durable DO SQLite tables.

## Caveat (read before believing the label)

`@cloudflare/think@0.6.1` does **not** ship a first-class "human-in-the-loop / requires-approval" tool primitive in this repo's pinned API set. What Think does ship — and what this example uses verbatim — is:

- `Think.beforeToolCall(ctx) -> ToolCallDecision` returning `{ action: "allow" | "block" | "substitute", … }`. The hook is the **single chokepoint** Think runs before any server tool's `execute` fires (see `node_modules/@cloudflare/think/dist/think.d.ts` lines 682–684 / 770–804).
- `Think.beforeTurn() -> { activeTools, toolChoice, … }` to force the gated turn to call exactly the sensitive tool, so the headless probe doesn't depend on stochastic model choice.
- `submitMessages()` + `inspectSubmission()` for durable, programmatic, no-WebSocket turn execution.

The "approval ticket" object, the `pending|approved|denied`/`used` state machine, the audit log, and the side-effect counter are **implemented in this example**, in DO SQLite, behind a server-enforced contract built around Think's hooks. They are not Think's own approval primitive. The example is labeled accordingly: the gating logic lives in `Approver.beforeToolCall` in [`src/worker.ts`](src/worker.ts), not in Think.

If Cloudflare later ships a first-class approval primitive for Think, the right migration is to swap this `beforeToolCall` enforcement for that primitive while keeping the `Approver` audit/state tables — the probe contract (denial path, no-approval path, exactly-once execution, replay blocked) stays the same.

## What the live probe proves

The probe in [`scripts/probe.ts`](scripts/probe.ts) deploys a real Worker to Cloudflare and asserts **three branches** end-to-end against the deployed `*.workers.dev` URL. Every assertion reads the durable audit table in DO SQLite.

| Branch | Setup | Expected audit row | Side-effect counter |
|---|---|---|---|
| A. denial | create ticket, `deny` it, then submit transfer | `decision=denied, reason=denied` | unchanged (`0`) |
| B. no_approval | submit transfer with a ticket nobody created | `decision=denied, reason=unknown_ticket` | unchanged (`0`) |
| C. approved | create ticket, `approve` it, submit transfer | `decision=executed, reason=approved` (exactly one row) | `+1` exactly |
| C-replay | re-submit the same ticket | `decision=denied, reason=already_used` | unchanged |

All four assertions are read directly from `GET /audit/:session` which reflects the DO SQLite `audit` and `side_effect` tables.

## Architecture

```
HTTP → Worker fetch → getAgentByName(Approver, sessionId)
                       │
                       ├── createTicket / decide  (RPC; writes approvals row)
                       │
                       ├── submitMessages([user msg with ticket])
                       │     │
                       │     └── Think submission drain → streamText → tool call
                       │                                                │
                       │                                  beforeToolCall ◄─ ENFORCEMENT POINT
                       │                                                │
                       │                                  ┌─────────────┴──────────────┐
                       │                                  │                            │
                       │                          block (reason)               allow → execute
                       │                                  │                            │
                       │                                  └──► audit row ──┘   side_effect++, used=1
                       │
                       └── getAudit / getSideEffect (read-only inspection)
```

All persisted state (approvals, audit, side_effect) lives in the Durable Object's SQLite storage, same lifetime as the conversation it gates.

## Files

- [`src/worker.ts`](src/worker.ts) — `Approver extends Think`, the `transfer_funds` tool, the `beforeToolCall` enforcement, the SQLite tables, the HTTP/RPC surface.
- [`alchemy.run.ts`](alchemy.run.ts) — isolated Worker definition. Refuses to deploy unless `CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_PERSONAL_ACCOUNT_ID`.
- [`scripts/probe.ts`](scripts/probe.ts) — the three-branch live assertion.
- [`scripts/run-e2e.sh`](scripts/run-e2e.sh) — deploy → warmup → probe → destroy, isolated to this example only.
- [`tsconfig.json`](tsconfig.json) — example-scoped typecheck; root tsconfig is untouched.

## Run the proof (isolated, personal account only)

Prereqs (from repo root): `bun install`, plus `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN` exported. Cloudflare auth is routed through the repo's `scripts/personal-env.sh` safety rail, which forces `CLOUDFLARE_ACCOUNT_ID := CLOUDFLARE_PERSONAL_ACCOUNT_ID`. The example's `alchemy.run.ts` then hard-fails if the deploy account doesn't equal the personal one.

```sh
bash examples/tool-approval-headless/scripts/run-e2e.sh
```

That command, in order:

1. typechecks **only** this example (`bunx tsc -p examples/tool-approval-headless/tsconfig.json`),
2. deploys **only** `tool-approval-<stage>` (default stage: `approval`) through the personal-account wrapper,
3. waits for the `*.workers.dev` `/health` route to come live,
4. runs `probe.ts` against the live URL,
5. destroys this Worker and its Durable Object on exit, even on failure.

Stage defaults to `approval` so it never collides with the root `personal` stage used by the other examples (which use a different alchemy app name `think-snippets`).

## Manual probing

If you want to drive the flow by hand against a live deploy (between steps 3 and 5 above, or after deploying without the cleanup trap), `WORKER_URL` is printed during deploy. Then:

```sh
# create + approve a ticket
curl -X POST "$WORKER_URL/approval/demo/create/my-ticket-1"
curl -X POST "$WORKER_URL/approval/demo/approve/my-ticket-1"

# request a transfer using that ticket (durable submission)
curl -X POST "$WORKER_URL/transfer/demo" \
  -H 'content-type: application/json' \
  -d '{"approvalTicket":"my-ticket-1","amount":25,"to":"savings"}'

# inspect the durable submission
curl "$WORKER_URL/transfer/demo/inspect/<submissionId>"

# inspect the durable audit + side-effect state
curl "$WORKER_URL/audit/demo"
```

## Cleanup

`scripts/run-e2e.sh` always runs `npx alchemy destroy --stage "$STAGE" --cwd <example dir>` in a trap, so the Worker and Durable Object are torn down whether the probe passes or fails. To clean up after a manual deploy:

```sh
STAGE=approval bash scripts/personal-env.sh \
  npx alchemy destroy --stage approval \
  --cwd examples/tool-approval-headless
```

(run from the repo root).
