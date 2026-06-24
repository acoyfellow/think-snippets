# cli-http-ground-truth

A Cloudflare Project Think agent whose **only source of truth is a real `cf`
CLI**, exposed over HTTP. This is the answer to "run an agent on Cloudflare and
give it access to a custom CLI as its ground truth for doing tasks" — the
HTTP/RPC flavor (see [`cli-sandbox-ground-truth`](../cli-sandbox-ground-truth)
for the in-sandbox flavor).

## The CLI is real, not a fixture

`cf <command>` runs the **actual Cloudflare API** against the deploying account
using the bound personal token. `cf account`, `cf whoami`, and `cf workers list`
return live account state that neither the model nor this repo authored. The
agent has one tool, `run_cf`, which shells out to the CLI service and must
report its stdout verbatim.

## What it proves

The probe:

1. reads the **true account name directly from the Cloudflare API** (its own
   independent call — not via the agent),
2. asks the agent for the account name (answerable only by running `cf`),
3. asserts the agent's answer contains the live account name — a hallucinated
   answer fails because it is checked against reality,
4. asserts a durable `cf_audit` row recorded the `run_cf account` call and that
   its stored stdout carried the same live name.

## Run

```sh
# from this directory
STAGE=local bash run-e2e.sh
```

Typechecks, deploys to your personal Cloudflare account (guarded —
`CLOUDFLARE_ACCOUNT_ID` must equal `CLOUDFLARE_PERSONAL_ACCOUNT_ID`), warms the
route, runs `probe.ts`, and destroys the Worker + Durable Object on exit. The
example binds your personal `CLOUDFLARE_API_TOKEN` so the `cf` CLI can read real
account state.

## Adapting it to your CLI

Replace the `runCf()` command switch with calls to your own CLI/service. The
agent contract is unchanged: one tool, stdout is ground truth, every call
audited.
