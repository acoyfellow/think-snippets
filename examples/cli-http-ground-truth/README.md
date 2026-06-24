# cli-http-ground-truth

A Cloudflare Project Think agent whose **only source of truth is a custom CLI**,
exposed over HTTP. This is the answer to "run an agent on Cloudflare and give it
access to a custom CLI as its ground truth for doing tasks" — the HTTP/RPC
flavor (see [`cli-sandbox-ground-truth`](../cli-sandbox-ground-truth) for the
in-sandbox-binary flavor).

## What it proves

The Worker hosts a tiny **CLI service** at `POST /cli` (a stand-in for the
operator's real CLI exposed over HTTP). The `CliAgent extends Think` Durable
Object has exactly one tool, `run_cli`, which shells out to that service and
returns its `{ exitCode, stdout, stderr }`. The system prompt forbids guessing:
the agent must call the CLI and report stdout verbatim.

The probe:

1. reads a **deploy-stable, unguessable token** from `/cli-token` (the CLI
   bakes it into `status` stdout as the `build:` line),
2. asks the agent for the build id (answerable only by running the CLI),
3. asserts the agent's answer contains that exact token — proof it used the CLI
   rather than hallucinating,
4. asserts a durable `cli_audit` row recorded the `run_cli` call and that its
   stored stdout carried the token.

## Run

```sh
# from this directory
STAGE=local bash run-e2e.sh
```

It typechecks, deploys to your personal Cloudflare account (guarded —
`CLOUDFLARE_ACCOUNT_ID` must equal `CLOUDFLARE_PERSONAL_ACCOUNT_ID`), warms the
route, runs `probe.ts`, and destroys the Worker + Durable Object on exit.

## Adapting it to a real CLI

Replace the in-Worker `cliRegistry` / `POST /cli` with a `fetch()` to your
actual CLI service (or a Worker that wraps it). The agent contract is unchanged:
one tool, stdout is ground truth, every call audited.
