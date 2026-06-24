import { Think } from '@cloudflare/think';
import { createWorkspaceTools } from '@cloudflare/think/tools/workspace';
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
  onDone?: () => void;
  onError?: (message: string) => void;
}

interface ToolLogRow extends Record<string, SqlStorageValue> {
  seq: number;
  ts: number;
  tool_name: string;
  input_json: string;
  output_json: string | null;
  success: number;
  duration_ms: number;
}

interface ToolLogEntry {
  seq: number;
  ts: number;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  durationMs: number;
}

interface SeedFile {
  path: string;
  content: string;
}

// The workspace search proof DO. The base `Think` already exposes a
// SQLite-backed `workspace` filesystem on `this.workspace`. We:
//
//   1. publish the full workspace tool set so the model has to use them,
//   2. record every tool call (input, output, success, duration) to a
//      private `tool_log` table inside the same DO storage so an external
//      probe can verify, after the fact, that the model actually invoked
//      search/list/read instead of hallucinating an answer.
//
// The `afterToolCall` hook is the AI SDK boundary at which Think hands us
// the discriminated outcome (`success: true, output` or `success: false,
// error`). Logging there cannot be skipped by the model.
export class WorkspaceAssistant extends Think<Env> {
  private _logTableEnsured = false;

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a strict workspace research assistant.',
      'You are NOT allowed to answer the user from memory or guess.',
      'You MUST locate the answer by calling workspace tools.',
      'Required procedure for every question:',
      '  1. Call `list` on "/" (or `find` with a glob) to discover candidate files.',
      '  2. Call `grep` or `find` to locate the file containing the requested fact.',
      '  3. Call `read` on that file and extract the exact value.',
      '  4. Then answer with only the value, no extra prose.',
      'If you answer without calling at least one of {list, find, grep} and at least one `read`, you have failed the task.',
    ].join('\n');
  }

  getTools() {
    return createWorkspaceTools(this.workspace);
  }

  // Persist evidence of every tool invocation. The probe reads this back
  // via RPC to prove the model actually used the workspace tools.
  async afterToolCall(ctx: {
    toolName: string;
    input?: unknown;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }) {
    this._ensureLogTable();
    const payload = ctx.success ? ctx.output : { error: serializeError(ctx.error) };
    this.ctx.storage.sql.exec(
      'INSERT INTO tool_log (ts, tool_name, input_json, output_json, success, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(),
      ctx.toolName,
      safeJson(ctx.input),
      safeJson(payload),
      ctx.success ? 1 : 0,
      Math.round(ctx.durationMs),
    );
  }

  private _ensureLogTable() {
    if (this._logTableEnsured) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS tool_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, success INTEGER NOT NULL, duration_ms INTEGER NOT NULL)'
    );
    this._logTableEnsured = true;
  }

  // RPC: seed multiple workspace files. The probe seeds 4-6 plausible
  // files and hides the unique fact in exactly one of them.
  async seedFiles(files: SeedFile[]): Promise<{ written: string[] }> {
    const written: string[] = [];
    for (const file of files) {
      await this.workspace.writeFile(file.path, file.content);
      written.push(file.path);
    }
    return { written };
  }

  // RPC: read the durable evidence log.
  async readToolLog(afterSeq = 0): Promise<ToolLogEntry[]> {
    this._ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<ToolLogRow>('SELECT seq, ts, tool_name, input_json, output_json, success, duration_ms FROM tool_log WHERE seq > ? ORDER BY seq ASC', afterSeq)
      .toArray();
    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      toolName: row.tool_name,
      input: tryParse(row.input_json),
      output: tryParse(row.output_json),
      success: row.success === 1,
      durationMs: row.duration_ms,
    }));
  }

  // RPC: full reset between probe runs.
  async resetAll(): Promise<void> {
    // Truncate evidence log.
    this._ensureLogTable();
    this.ctx.storage.sql.exec('DELETE FROM tool_log');
    // Best-effort workspace clear: list root, rm each entry.
    const entries = await this.workspace.readDir('/');
    for (const entry of entries) {
      try {
        await this.workspace.rm(entry.path, { recursive: true, force: true });
      } catch {
        // Ignore missing / racing entries.
      }
    }
    // Clear chat history so prior turns can't leak the fact.
    this.clearMessages();
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ __unserializable: String(value) });
  }
}

function tryParse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function assistant(env: Env, sessionId: string) {
  // getAgentByName() guarantees PartyServer/Agents onStart() has resolved
  // before user RPC methods run — same pattern as the chat-rpc example.
  return getAgentByName(env.WorkspaceAssistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function seed(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const files = Array.isArray(body.files) ? (body.files as SeedFile[]) : [];
  if (!files.length) return json({ ok: false, error: 'files[] required' }, { status: 400 });
  const stub = (await assistant(env, sessionId)) as unknown as {
    seedFiles: (files: SeedFile[]) => Promise<{ written: string[] }>;
  };
  const result = await stub.seedFiles(files);
  return json({ ok: true, sessionId, ...result });
}

async function chat(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Hello.';
  const stub = (await assistant(env, sessionId)) as unknown as {
    chat: (userMessage: string, callback: StreamCallback) => Promise<void>;
  };

  let answer = '';
  let error: string | undefined;
  await stub.chat(message, {
    onStart() {},
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        // Non-JSON control frames contain no answer text.
      }
    },
    onDone() {},
    onError(message) {
      error = message;
    },
  });

  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, answer });
}

async function tools(env: Env, sessionId: string, afterSeq: number) {
  const stub = (await assistant(env, sessionId)) as unknown as {
    readToolLog: (afterSeq?: number) => Promise<ToolLogEntry[]>;
  };
  const log = await stub.readToolLog(afterSeq);
  return json({ ok: true, sessionId, log });
}

async function reset(env: Env, sessionId: string) {
  const stub = (await assistant(env, sessionId)) as unknown as {
    resetAll: () => Promise<void>;
  };
  await stub.resetAll();
  return json({ ok: true, sessionId });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'think-snippets-workspace-search',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = path;

    if (request.method === 'POST' && kind === 'seed' && sessionId) return seed(request, env, sessionId);
    if (request.method === 'POST' && kind === 'chat' && sessionId) return chat(request, env, sessionId);
    if (request.method === 'POST' && kind === 'reset' && sessionId) return reset(env, sessionId);
    if (request.method === 'GET' && kind === 'tools' && sessionId) {
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0;
      return tools(env, sessionId, afterSeq);
    }

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
