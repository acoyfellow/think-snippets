// Isolated example Worker: workspace-write-read-proof.
//
// Goal of this Worker: prove that Project Think's built-in workspace tools
// (auto-merged into every chat turn) really write to a durable DO-backed
// filesystem — not just to the model's response text.
//
// How that's proved:
// 1. POST /chat/:session asks the assistant to call the `write` tool with a
//    caller-provided path and content. The tool runs server-side inside the
//    DO and writes to `this.workspace`, which is a `@cloudflare/shell`
//    Workspace persisted in the DO's own SQLite storage.
// 2. GET /inspect/:session/file?path=... bypasses the model entirely and
//    invokes a plain DO RPC method that calls `this.workspace.readFile(path)`
//    directly. The returned content is durable filesystem evidence — not
//    prompt-leak echo.
//
// Lives entirely in this example directory. Shares no code with src/worker.ts.

import { Think } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

export interface Env {
  AI: Ai;
  WorkspaceAssistant: DurableObjectNamespace<WorkspaceAssistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface StreamCallback {
  onStart: (event: unknown) => void;
  onEvent: (json: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

interface InspectFileResult {
  path: string;
  exists: boolean;
  content: string | null;
  size: number | null;
}

interface InspectListResult {
  dir: string;
  entries: { name: string; isDirectory: boolean; size?: number }[];
}

export class WorkspaceAssistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a workspace operator agent.',
      'When the user instructs you to write a file, you MUST call the `write` tool exactly once with the path and content the user provides verbatim. Do not paraphrase the content.',
      'After the tool call completes, reply with exactly one short line: "wrote <path>".',
    ].join(' ');
  }

  /**
   * Plain DO RPC: read a workspace path directly. This is the inspection
   * probe — it does NOT go through the model. It reads the same durable
   * Workspace that the `write` tool wrote to.
   */
  async inspectFile(path: string): Promise<InspectFileResult> {
    const content = await this.workspace.readFile(path);
    if (content === null) return { path, exists: false, content: null, size: null };
    return { path, exists: true, content, size: new TextEncoder().encode(content).byteLength };
  }

  /**
   * Plain DO RPC: list a workspace directory. Used to assert the file
   * appears as a real filesystem entry, not just as readable bytes.
   */
  async inspectList(dir: string): Promise<InspectListResult> {
    // `Workspace.readDir` returns FileInfo[] with `name`, `type`, `size`.
    const raw = (await this.workspace.readDir(dir)) as Array<{ name: string; type: string; size: number }>;
    return {
      dir,
      entries: raw.map((e) => ({
        name: e.name,
        isDirectory: e.type === 'directory',
        size: e.size,
      })),
    };
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function assistant(env: Env, sessionId: string) {
  // Same pattern as src/worker.ts: getAgentByName awaits agent init before
  // user RPC methods like chat() / inspectFile() run.
  return getAgentByName(env.WorkspaceAssistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function chat(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Hello.';
  const stub = (await assistant(env, sessionId)) as unknown as {
    chat: (userMessage: string, callback: StreamCallback) => Promise<void>;
  };

  let answer = '';
  const toolCalls: { name: string; args?: unknown }[] = [];
  let error: string | undefined;
  await stub.chat(message, {
    onStart() {},
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk & {
          type: string;
          toolName?: string;
          input?: unknown;
        };
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
        // Record observable tool invocations for diagnostics (not used as proof).
        if (chunk.type === 'tool-input-available' || chunk.type === 'tool-call') {
          toolCalls.push({ name: String(chunk.toolName ?? 'unknown'), args: chunk.input });
        }
      } catch {
        // Think emits non-JSON control frames. Ignore — proof is durable, not stream-derived.
      }
    },
    onDone() {
      // Required: Think's RPC stream contract expects an explicit completion ack.
    },
    onError(message) {
      error = message;
    },
  });

  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, answer, toolCalls });
}

async function inspectFile(request: Request, env: Env, sessionId: string) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path) return json({ ok: false, error: 'path query param required' }, { status: 400 });
  const stub = (await assistant(env, sessionId)) as unknown as {
    inspectFile: (path: string) => Promise<InspectFileResult>;
  };
  const result = await stub.inspectFile(path);
  return json({ ok: true, sessionId, file: result });
}

async function inspectList(request: Request, env: Env, sessionId: string) {
  const url = new URL(request.url);
  const dir = url.searchParams.get('dir') ?? '/';
  const stub = (await assistant(env, sessionId)) as unknown as {
    inspectList: (dir: string) => Promise<InspectListResult>;
  };
  const result = await stub.inspectList(dir);
  return json({ ok: true, sessionId, list: result });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'workspace-write-read-proof',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, action] = path;

    if (request.method === 'POST' && kind === 'chat' && sessionId) {
      return chat(request, env, sessionId);
    }
    if (request.method === 'GET' && kind === 'inspect' && sessionId && action === 'file') {
      return inspectFile(request, env, sessionId);
    }
    if (request.method === 'GET' && kind === 'inspect' && sessionId && action === 'list') {
      return inspectList(request, env, sessionId);
    }

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
