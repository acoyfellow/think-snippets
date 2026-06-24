// Isolated example: "my CLI is the ground truth" — sandbox flavor.
//
// Frank's ask, the hermes/openclaw-style framing: an agent on Cloudflare that
// runs the user's CLI and treats its stdout as the ground truth for a task.
// Here the "CLI" is a small JS program executed inside the codemode sandbox
// (a DynamicWorkerExecutor isolate) via @cloudflare/think's execute tool.
//
// The proof: the sandbox CLI computes a deterministic, runtime-only result
// (a token derived from per-run input). The probe asserts the value the agent
// reports as the task result EQUALS the sandbox CLI's stdout — and that a
// deliberately wrong guess would not match. The model never sees the token; it
// only sees it by running the CLI.

import { Think } from '@cloudflare/think';
import { createExecuteTool } from '@cloudflare/think/tools/execute';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';
import type { Tool } from 'ai';

// codemode >=0.4 runs sandboxed code in a CodemodeRuntime facet that must be
// exported from the worker entry.
export { CodemodeRuntime } from '@cloudflare/codemode';

export interface Env {
  AI: Ai;
  CliSandbox: DurableObjectNamespace<CliSandbox>;
  LOADER: WorkerLoader;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface ExecuteToolOutput {
  status?: string;
  result?: unknown;
  error?: string;
}

// The user's "CLI", shipped to the sandbox as source. It reads its argument
// and emits a deterministic stdout line. In a real setup this is the user's
// compiled CLI / script; the contract is identical: stdout is ground truth.
function cliProgramSource(arg: string): string {
  return `
    // ---- user CLI (runs inside the sandbox isolate) ----
    function mycli(input) {
      // Deterministic transform the model cannot precompute without running it.
      let h = 5381;
      for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
      return 'RESULT ' + input + ' => ' + h.toString(16);
    }
    return { stdout: mycli(${JSON.stringify(arg)}) };
  `;
}

export class CliSandbox extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return 'Sandbox CLI ground-truth example assistant.';
  }

  private executeTool(): Tool {
    return createExecuteTool(this, {}) as Tool;
  }

  // Run the user's CLI inside the sandbox and return its stdout. This is the
  // ground-truth path: the deterministic transform only resolves by executing.
  async runCli(arg: string): Promise<{ stdout: string }> {
    const tool = this.executeTool();
    if (typeof tool.execute !== 'function') throw new Error('execute tool missing execute()');
    const out = (await tool.execute(
      { code: cliProgramSource(arg) },
      { toolCallId: `cli-${crypto.randomUUID()}`, messages: [] },
    )) as ExecuteToolOutput;
    const result = out?.result as { stdout?: string } | undefined;
    if (!result || typeof result.stdout !== 'string') {
      throw new Error(`sandbox CLI did not return stdout: ${JSON.stringify(out)}`);
    }
    return { stdout: result.stdout };
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function stubFor(env: Env, sessionId: string) {
  return getAgentByName(env.CliSandbox, sessionId, { routingRetry: { maxAttempts: 3 } });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'cli-sandbox-ground-truth',
        loaderBound: typeof env.LOADER?.get === 'function',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = parts;
    if (request.method === 'POST' && kind === 'cli' && sessionId) {
      const body = (await request.json().catch(() => ({}))) as { arg?: string };
      const stub = (await stubFor(env, sessionId)) as unknown as {
        runCli: (arg: string) => Promise<{ stdout: string }>;
      };
      const result = await stub.runCli(String(body.arg ?? 'task'));
      return json({ ok: true, sessionId, ...result });
    }
    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
