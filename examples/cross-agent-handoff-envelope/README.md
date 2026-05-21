# cross-agent-handoff-envelope

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/think-snippets)

Two Cloudflare Project Think agents (`Producer` and `Consumer`) cooperate by exchanging a **typed, deterministic, checksum-protected handoff envelope** through a separate durable store. The transfer channel is machine-readable: chat is used only as durable audit evidence, never to carry the runtime fact.

This example is isolated. It does not share `src/`, `alchemy.run.ts`, or `scripts/` with the repo root. Its own worker, alchemy app, personal-account guard, probe, and E2E cleanup live here.

## What is proved live

| Probe assertion | Verifies |
|---|---|
| `/health` reports `deployAccountMatchesExpected: true` and `envelopeSchema: cross-agent-handoff/v1` | personal-account guard fired at deploy time |
| `POST /handoff/produce` returns an envelope that parses `HandoffEnvelopeSchema` and whose `payload.token` equals the runtime-injected token | typed, deterministic transfer (not LLM prose) |
| `sha256` checksum over canonical-JSON(`payload`) recomputes identically on the worker and on the prober | tamper-evident transfer integrity |
| `POST /handoff/consume` lets a **different** DO/session (`Consumer`) receive the same token through `HandoffStore` only | cross-agent transfer, not chat-history leakage |
| `HandoffStore` record is annotated with the consumer's `submissionId` | machine-readable cross-agent linkage |
| `inspectSubmission()` on the Consumer DO reaches `completed` with `metadata.receivedToken === runtime token` | durable evidence on the second agent |

## How the envelope is built

[`src/envelope.ts`](src/envelope.ts) defines `HandoffEnvelopeSchema` (zod) at version `cross-agent-handoff/v1`. `buildEnvelope()` constructs the envelope in Worker code from a runtime token + intent, computes `sha256` over canonical-JSON of the payload, and freezes producer/consumer session ids into the envelope. `verifyEnvelope()` re-parses the schema and recomputes the checksum; it is called by the `HandoffStore` DO on both `put` and `get`, and by the prober.

The LLM never authors the envelope. The producer Think agent is only told the envelope id and asked to acknowledge it via `submitMessages()`, so a real durable submission entry exists on the producer DO too.

## Architecture

```
runtime token ─▶ Worker /handoff/produce
                       │
                       ├── buildEnvelope() ── typed JSON, sha256 checksum
                       │
                       ├── HandoffStore DO (idFromName envelopeId) ── PUT envelope
                       │
                       └── Producer Think DO (submitMessages, metadata=envelope)
                                                      │
                                                  inspectSubmission ▶ durable audit

           ─▶ Worker /handoff/consume { envelopeId }
                       │
                       ├── HandoffStore.get(envelopeId) ── re-verify checksum
                       │
                       ├── Consumer Think DO (submitMessages, metadata.receivedToken)
                       │                              │
                       │                          inspectSubmission ▶ durable audit
                       │
                       └── HandoffStore.annotateConsumer(submissionId)
```

Three Durable Object classes live in [`src/worker.ts`](src/worker.ts):

- `Producer extends Think` — issues the handoff acknowledgement.
- `Consumer extends Think` — receives the token from the durable envelope and echoes it.
- `HandoffStore extends DurableObject` — the only transfer channel between the two agents; stores and re-verifies envelopes.

## Personal Cloudflare safety rail

[`scripts/personal-env.sh`](scripts/personal-env.sh) forces:

```sh
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_PERSONAL_ACCOUNT_ID"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PERSONAL_API_TOKEN"
```

[`alchemy.run.ts`](alchemy.run.ts) hard-fails unless the deploy account equals `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. The live `/health` probe assertion re-attests that equality at deploy time.

## Run the proof

From this directory:

```sh
bash scripts/run-e2e.sh
```

That command:

1. typechecks this example's TypeScript only,
2. deploys via this example's own Alchemy app through the personal-account wrapper,
3. curls the live `*.workers.dev` Worker,
4. drives the live `/handoff/produce` + `/handoff/consume` flow with a runtime token,
5. verifies the typed envelope, the checksum, the cross-agent machine-readable transfer, and the durable consumer-side submission,
6. destroys the worker + all three Durable Object namespaces on exit.

Required env: `CLOUDFLARE_PERSONAL_ACCOUNT_ID`, `CLOUDFLARE_PERSONAL_API_TOKEN`.
