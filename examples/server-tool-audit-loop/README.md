# server-tool-audit-loop

Minimal proof that a Project Think Durable Object can:

1. Expose a **custom server-side tool** the model can call (`revealCalibrationCode`).
2. Return a value from that tool that the model could not have invented — a deterministic 12-hex-char code derived from a per-DO runtime seed (`crypto.randomUUID()` minted on first use and pinned in SQLite).
3. **Durably record every tool execution** in a `tool_audit` SQLite table inside the same DO, via the `afterToolCall` lifecycle hook.
4. Prove from the outside that the assistant's text answer actually consumed the tool's output (the runtime code appears verbatim in the response).

This example is self-contained. It does not modify the root `src/worker.ts`, root `alchemy.run.ts`, or any shared script. It deploys to its own isolated alchemy app (`think-stool-audit`) and Worker name, defaulting to the stage `local`. (Short names keep the resulting `*.workers.dev` subdomain under Cloudflare's 63-char limit.)

## Layout

| File | Purpose |
|---|---|
| [`worker.ts`](worker.ts) | `Auditor extends Think<Env>` with one custom tool + audit logging + RPC to read the audit log. |
| [`alchemy.run.ts`](alchemy.run.ts) | Isolated personal-only Cloudflare deploy. Hard-fails unless the deploy account equals `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. |
| [`probe.ts`](probe.ts) | Sends one chat turn, then asserts (a) a durable audit row exists, (b) its recorded input matches the probe label, (c) its recorded output carries a runtime-derived code, and (d) the assistant's answer contains that exact code. |
| [`run-e2e.sh`](run-e2e.sh) | Typecheck → personal-account deploy → warm `/health` → run probe → always destroy on exit. |
| [`tsconfig.json`](tsconfig.json) | Isolated typecheck for this example only. |

## How it proves the loop

The `revealCalibrationCode` tool returns `{ label, code, source: "runtime-derived" }`. The `code` is `sha256(seed || "::" || label).slice(0, 12)` where `seed` is a UUID pinned in `tool_runtime` inside the DO's SQLite storage. The model has no way to derive that hash without calling the tool.

The probe sends a random `label` per run, so the expected `code` differs every run and cannot be cached. The system prompt forces the model to reply in the exact format `code=<code>`. After the turn the probe:

- reads `GET /audit/:session`, picks the latest successful `revealCalibrationCode` row, and parses its stored input/output JSON;
- confirms the recorded `input.label` matches the probe-issued label (proves the model wired the user's request into the tool input);
- confirms the recorded `output.code` is a 12-hex string with `source = "runtime-derived"` (proves the tool actually executed against runtime state, not a hallucinated payload);
- confirms the assistant's streamed text answer contains the exact same `code` (proves the tool's output reached the model and was used to produce the response).

If any link in that chain is broken — the model skips the tool, the tool isn't audited, the audit row carries fabricated content, or the model invents its own code — the probe fails.

## Run

The example requires `CLOUDFLARE_PERSONAL_ACCOUNT_ID` and `CLOUDFLARE_PERSONAL_API_TOKEN` in the environment (same rail as the root repo). From this directory:

```sh
bun install   # only needed once, from the repo root
bash run-e2e.sh
```

`run-e2e.sh` always runs `alchemy destroy` on exit (success, failure, or signal), so no Cloudflare resources are left behind.
