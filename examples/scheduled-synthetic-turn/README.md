# scheduled-synthetic-turn

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Server-triggered Project Think turn: no client chat RPC, no real cron. A
single HTTP request enqueues a near-immediate Agent `schedule()` row; when
the Durable Object alarm fires, the DO injects a synthetic user message
into Think via `saveMessages()`, which runs a real model turn and persists
both the synthetic user message and the assistant reply in DO SQLite. The
probe then polls persisted history until the assistant reply echoes a
calibration word, proving the scheduled path executed end to end.

## How the path works

1. `POST /trigger/:sessionId` (Worker fetch) calls
   `ScheduledAssistant.triggerScheduled(prompt)` via the Agents RPC stub.
2. `triggerScheduled()` calls
   `this.schedule(1, "runSyntheticTurn", { prompt, triggeredAt })`. This is
   the Agents base-class scheduler — a delay of `1` second is deterministic
   and *does not* wait on any real cron expression. The row is persisted in
   the DO's SQLite schedule table; Cloudflare wakes the DO via its alarm.
3. When the alarm fires, the Agents runtime invokes
   `runSyntheticTurn(payload)`. That method builds a `UIMessage` with role
   `user` and calls Think `saveMessages([userMsg])`. Per the upstream
   Think docs, `saveMessages()` is the documented entry point for
   *"scheduled responses, webhook-triggered turns, proactive agents"* —
   it injects the message and triggers a model turn without a WebSocket.
4. Think runs inference against `@cf/moonshotai/kimi-k2.6` and persists
   the assistant message back into the conversation.
5. `GET /history/:sessionId` returns `Think.getMessages()`. The probe
   polls until it sees both the injected user message and a non-empty
   assistant reply, then asserts the reply contains the calibration word
   that was embedded in the synthetic prompt.

This isolates the scheduled / server-triggered path from the
`/chat/:sessionId` request-driven path proved in `examples/chat-rpc`, and
from the `submitMessages()` durable programmatic-acceptance path proved in
`examples/durable-submit`.

## Endpoints

| Method | Path                       | Purpose                                              |
|--------|----------------------------|------------------------------------------------------|
| GET    | `/health`                  | Liveness + personal-account attestation              |
| POST   | `/trigger/:sessionId`      | Body `{ prompt }`. Enqueues the 1s-delay schedule.   |
| GET    | `/history/:sessionId`      | Returns persisted Think messages for the session.    |

`POST /trigger/:sessionId` returns the `scheduleId` so observers can
correlate the alarm with the history row that appears ~1s later.

## Personal-account guard

This example is deployed by its own `alchemy.run.ts`, but Cloudflare
operations still go through the shared, root-level wrapper
`../../scripts/personal-env.sh`, which forces:

```sh
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
```

The local `alchemy.run.ts` hard-fails unless `CLOUDFLARE_ACCOUNT_ID`
equals `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. The live `/health` endpoint
re-attests that equality at deploy time, and the probe refuses to
continue otherwise. The example uses its own alchemy app name
(`think-snippets-scheduled-synthetic-turn`) and Worker name
(`think-snippets-scheduled-synthetic-turn-<stage>`), so it does not
collide with the root `think-snippets` app or with any other example.
Names are kept short (`think-sched-turn`) because Cloudflare composes
`<worker>-<app>-<stage>` into the `*.workers.dev` subdomain, which has
a 63-character limit.

## Run the proof

From the repo root:

```sh
bun install
bash examples/scheduled-synthetic-turn/scripts/run-e2e.sh
```

That:

1. typechecks the whole repo (root `tsconfig.json` already covers
   `examples/**/*.ts`),
2. deploys only via the personal-account wrapper,
3. waits for the live `*.workers.dev` Worker to respond,
4. enqueues a 1s-delay schedule and polls persisted history,
5. destroys the example's Worker + Durable Object on exit (pass or fail).

## What it does NOT do

- Does **not** wait on a real cron expression. `schedule(1, …)` uses a
  numeric delay in seconds; cron support exists in the Agents API but
  would make the E2E nondeterministic.
- Does **not** use `submitMessages()`. That is the durable
  programmatic-submission path proved separately in
  `examples/durable-submit`. This example proves the lower-level
  scheduled / proactive path documented for Think (`saveMessages()` from
  inside an alarm callback).
- Does **not** edit any shared file under `src/`, `scripts/`, the root
  `alchemy.run.ts`, or the root `package.json`. Everything specific to
  this example lives under `examples/scheduled-synthetic-turn/`.

## Source

- Worker: [`src/worker.ts`](src/worker.ts)
- Alchemy deploy: [`alchemy.run.ts`](alchemy.run.ts)
- Probe: [`scripts/probe.ts`](scripts/probe.ts)
- E2E lifecycle: [`scripts/run-e2e.sh`](scripts/run-e2e.sh)
