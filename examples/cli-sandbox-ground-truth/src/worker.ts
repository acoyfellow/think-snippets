// Isolated example: a real `cf` CLI as the agent's ground truth — sandbox flavor.
//
// The agent runs code inside the codemode sandbox (a DynamicWorkerExecutor
// isolate). Inside that sandbox it can call `tools.cf({ command })`, a real
// Cloudflare CLI that hits the live account API. The sandbox composes the call;
// the bound token stays server-side (it never enters the sandbox). The ground
// truth is the actual account, so a hallucinated answer fails against reality.

import { Think } from '@cloudflare/think';
import { createExecuteTool } from '@cloudflare/think/tools/execute';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Tool } from 'ai';
import { z } from 'zod';

// codemode >=0.4 runs sandboxed code in a CodemodeRuntime facet that must be
// exported from the worker entry.
export { CodemodeRuntime } from '@cloudflare/codemode';

export interface Env {
  AI: Ai;
  CliSandbox: DurableObjectNamespace<CliSandbox>;
  LOADER: WorkerLoader;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface ExecuteToolOutput {
  status?: string;
  result?: unknown;
  error?: string;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

// The real `cf` CLI, exposed to the sandbox as a tool. Runs server-side
// against the live Cloudflare account; output is genuine account state.
async function runCf(command: string, env: Env): Promise<string> {
  const [name, ...rest] = command.trim().split(/\s+/);
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };
  const get = async (path: string) => {
    const res = await fetch(`${CF_API}${path}`, { headers });
    return (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown };
  };
  switch (name) {
    case 'account': {
      const j = await get(`/accounts/${env.CF_ACCOUNT_ID}`);
      const r = (j.result ?? {}) as { name?: string; id?: string };
      if (j.success === false) return `cf: account failed: ${JSON.stringify(j.errors)}`;
      return `name: ${r.name ?? ''}\nid: ${r.id ?? ''}`;
    }
    case 'workers': {
      if (rest[0] !== 'list') return `cf: unknown workers subcommand: ${rest[0] ?? ''}`;
      const j = await get(`/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`);
      const scripts = (j.result ?? []) as unknown[];
      if (j.success === false) return `cf: workers list failed: ${JSON.stringify(j.errors)}`;
      return `count: ${scripts.length}`;
    }
    default:
      return `cf: command not found: ${name}`;
  }
}

export class CliSandbox extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }
  getSystemPrompt() {
    return 'Sandbox cf-CLI ground-truth example assistant.';
  }

  private executeTool(): Tool {
    // Expose the real cf CLI as a sandbox tool: inside generated code, call
    // `tools.cf({ command })`. The secret token stays out of the sandbox.
    const env = this.env;
    return createExecuteTool(this, {
      tools: {
        cf: tool({
          description: 'Run a real Cloudflare cf CLI command; returns live account stdout.',
          inputSchema: z.object({ command: z.string().min(1).max(120) }),
          execute: async ({ command }) => ({ stdout: await runCf(command, env) }),
        }),
      },
    }) as Tool;
  }

  // Drive a sandbox program that calls the real cf CLI and returns its stdout.
  async sandboxCf(command: string): Promise<{ stdout: string }> {
    const t = this.executeTool();
    if (typeof t.execute !== 'function') throw new Error('execute tool missing execute()');
    const code = `
      // ---- runs inside the codemode sandbox isolate ----
      const out = await tools.cf({ command: ${JSON.stringify(command)} });
      return { stdout: out.stdout };
    `;
    const out = (await t.execute(
      { code },
      { toolCallId: `cf-${crypto.randomUUID()}`, messages: [] },
    )) as ExecuteToolOutput;
    const result = out?.result as { stdout?: string } | undefined;
    if (!result || typeof result.stdout !== 'string') {
      throw new Error(`sandbox did not return cf stdout: ${JSON.stringify(out)}`);
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
    if (request.method === 'POST' && kind === 'cf' && sessionId) {
      const body = (await request.json().catch(() => ({}))) as { command?: string };
      const stub = (await stubFor(env, sessionId)) as unknown as {
        sandboxCf: (command: string) => Promise<{ stdout: string }>;
      };
      const result = await stub.sandboxCf(String(body.command ?? 'account'));
      return json({ ok: true, sessionId, ...result });
    }
    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
