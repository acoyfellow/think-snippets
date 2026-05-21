// Isolated example: createExecuteTool + state backend.
//
// An `Assistant extends Think` Durable Object exposes a workspace via
// `createWorkspaceStateBackend()`, then wires it into `createExecuteTool()`
// from `@cloudflare/think/tools/execute`. That tool routes generated
// JavaScript into an isolated dynamic Worker created via the
// `worker_loaders` runtime binding (a `DynamicWorkerExecutor` under the
// hood). Inside that sandbox, `state.writeFile()` / `state.readFile()` are
// available alongside `codemode.*` tools.
//
// The proof here deliberately does not depend on the LLM choosing to call
// the execute tool. The Worker calls the tool's `execute()` function
// directly with a fixed snippet of guest code so the live probe can
// deterministically verify three things:
//   1. The sandbox actually ran (returned its own `result` payload).
//   2. The sandboxed code mutated the Think workspace state by writing a
//      file the parent DO can later read back.
//   3. The sandbox is network-isolated by default (fetch() throws).
//
// This file is self-contained: it does not import or modify shared
// project files (../../src/worker.ts is untouched).

import { Think } from '@cloudflare/think';
import { createExecuteTool } from '@cloudflare/think/tools/execute';
import { createWorkspaceStateBackend, Workspace } from '@cloudflare/shell';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';
import type { Tool, ToolSet } from 'ai';

export interface Env {
  AI: Ai;
  Assistant: DurableObjectNamespace<Assistant>;
  // Provided by the `worker_loaders` binding in alchemy.run.ts.
  LOADER: WorkerLoader;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface ExecuteToolInput {
  code: string;
}
interface ExecuteToolOutput {
  result: unknown;
  logs?: string[];
}
type ExecuteTool = Tool<ExecuteToolInput, ExecuteToolOutput>;

export class Assistant extends Think<Env> {
  // Override the default Workspace so we are 100% sure which sql backend
  // is used and so the rest of this example can reach it directly through
  // `this.workspace` for read-back evidence.
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name,
  });

  getModel() {
    // Required by Think even though this example never runs inference for
    // its proof. Pinned to the same model used elsewhere in this repo.
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return 'Sandboxed-execution example assistant.';
  }

  // Expose the execute tool both inside the standard tool set (so a real
  // chat turn could use it) and as a directly callable method (so the
  // probe can drive it deterministically).
  override getTools(): ToolSet {
    return { execute: this.executeTool() };
  }

  private executeTool(): ExecuteTool {
    return createExecuteTool({
      tools: {},
      state: createWorkspaceStateBackend(this.workspace),
      loader: this.env.LOADER,
      // Default `globalOutbound: null` keeps fetch()/connect() blocked
      // inside the sandbox. The probe asserts this.
    }) as ExecuteTool;
  }

  /**
   * RPC method invoked by the Worker `/execute/:sessionId` route. Runs
   * `code` inside a sandboxed dynamic Worker via the execute tool and
   * returns the tool's structured output verbatim.
   */
  async runSandboxed(code: string): Promise<ExecuteToolOutput> {
    const tool = this.executeTool();
    if (typeof tool.execute !== 'function') {
      throw new Error('createExecuteTool returned a tool without execute()');
    }
    const output = await tool.execute(
      { code },
      {
        toolCallId: `probe-${crypto.randomUUID()}`,
        messages: [],
      },
    );
    // ToolExecuteFunction can in principle yield an AsyncIterable. The
    // execute tool returns a Promise<CodeOutput> in practice, so just
    // normalise.
    if (output && typeof (output as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      let last: unknown = undefined;
      for await (const chunk of output as AsyncIterable<unknown>) last = chunk;
      return last as ExecuteToolOutput;
    }
    return output as ExecuteToolOutput;
  }

  /**
   * Direct read of workspace state so the probe can verify that
   * sandboxed code actually wrote into the Think workspace owned by this
   * DO.
   */
  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function assistant(env: Env, sessionId: string) {
  // Mirrors the convention used by ../../src/worker.ts: getAgentByName
  // awaits PartyServer initialization before invoking user RPC.
  return getAgentByName(env.Assistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

interface AssistantRpc {
  runSandboxed: (code: string) => Promise<ExecuteToolOutput>;
  readWorkspaceFile: (path: string) => Promise<string | null>;
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function execute(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const code = typeof body.code === 'string' ? body.code : '';
  if (!code) return json({ ok: false, error: 'missing code' }, { status: 400 });
  const stub = (await assistant(env, sessionId)) as unknown as AssistantRpc;
  const output = await stub.runSandboxed(code);
  return json({ ok: true, sessionId, output });
}

async function read(request: Request, env: Env, sessionId: string, path: string) {
  const stub = (await assistant(env, sessionId)) as unknown as AssistantRpc;
  const content = await stub.readWorkspaceFile(path);
  return json({ ok: true, sessionId, path, content });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'execute-tool-state-edit',
        loaderBound: typeof env.LOADER?.get === 'function',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, ...rest] = segments;
    if (request.method === 'POST' && kind === 'execute' && sessionId) {
      return execute(request, env, sessionId);
    }
    if (request.method === 'GET' && kind === 'state' && sessionId && rest.length) {
      return read(request, env, sessionId, '/' + rest.join('/'));
    }
    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
