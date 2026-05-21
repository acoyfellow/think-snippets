import { Think } from '@cloudflare/think';
import type { ToolCallResultContext } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

// Isolated example: a Think Durable Object with one custom server-side tool.
// The tool returns a deterministic value derived from per-DO runtime state
// that the model cannot guess. Every tool call is durably recorded in a
// SQLite audit table. The probe proves the tool executed and that its output
// reached the assistant's response.

export interface Env {
  AI: Ai;
  Auditor: DurableObjectNamespace<Auditor>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface StreamCallback {
  onEvent: (json: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

interface AuditRow {
  id: number;
  ts: number;
  toolName: string;
  input: string;
  output: string;
  success: number;
  durationMs: number;
}

const calibrationInputSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(64)
    .describe('Short identifier the operator gave for this calibration request.'),
});

export class Auditor extends Think<Env> {
  private _auditTableReady = false;

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a strict calibration assistant.',
      'When the operator asks for a calibration code, you MUST call the revealCalibrationCode server tool with the label they gave you.',
      'You MUST NOT invent a code. You MUST quote the code returned by the tool exactly as the tool returned it.',
      'After the tool returns, answer in this exact format: "code=<code>" and nothing else.',
    ].join(' ');
  }

  getTools() {
    return {
      revealCalibrationCode: tool({
        description:
          'Reveal the deterministic calibration code for a given label. Only the runtime knows the seed; the model cannot guess this value.',
        inputSchema: calibrationInputSchema,
        execute: async ({ label }) => {
          const seed = this._getOrCreateRuntimeSeed();
          const code = await deriveCode(seed, label);
          return { label, code, source: 'runtime-derived' };
        },
      }),
    };
  }

  async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    this._ensureAuditTable();
    const inputJson = safeStringify(ctx.input);
    const outputJson = ctx.success ? safeStringify(ctx.output) : safeStringify({ error: String(ctx.error) });
    this.ctx.storage.sql.exec(
      'INSERT INTO tool_audit (ts, tool_name, input, output, success, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(),
      ctx.toolName,
      inputJson,
      outputJson,
      ctx.success ? 1 : 0,
      Math.round(ctx.durationMs),
    );
  }

  // RPC: list durable audit rows so the probe can prove the tool actually executed.
  async listAudit(): Promise<AuditRow[]> {
    this._ensureAuditTable();
    const cursor = this.ctx.storage.sql.exec<{
      id: number;
      ts: number;
      tool_name: string;
      input: string;
      output: string;
      success: number;
      duration_ms: number;
    }>('SELECT id, ts, tool_name, input, output, success, duration_ms FROM tool_audit ORDER BY id ASC');
    return cursor.toArray().map((row) => ({
      id: row.id,
      ts: row.ts,
      toolName: row.tool_name,
      input: row.input,
      output: row.output,
      success: row.success,
      durationMs: row.duration_ms,
    }));
  }

  private _ensureAuditTable() {
    if (this._auditTableReady) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS tool_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool_name TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL, success INTEGER NOT NULL, duration_ms INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS tool_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    this._auditTableReady = true;
  }

  private _getOrCreateRuntimeSeed(): string {
    this._ensureAuditTable();
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM tool_runtime WHERE key = ?', 'seed')
      .toArray()[0];
    if (row) return row.value;
    const seed = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO tool_runtime (key, value) VALUES (?, ?)', 'seed', seed);
    return seed;
  }
}

async function deriveCode(seed: string, label: string): Promise<string> {
  const data = new TextEncoder().encode(`${seed}::${label}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  // 12-hex-char deterministic code: short, easy to spot in the assistant's answer.
  return bytes.slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function auditor(env: Env, sessionId: string) {
  return getAgentByName(env.Auditor, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function chat(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string'
    ? body.message
    : 'Reveal the calibration code for label "default".';
  const stub = (await auditor(env, sessionId)) as unknown as {
    chat: (userMessage: string, callback: StreamCallback) => Promise<void>;
  };

  let answer = '';
  let error: string | undefined;
  await stub.chat(message, {
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        // Non-JSON control frames do not carry answer text.
      }
    },
    onDone() {
      // Acknowledge stream completion.
    },
    onError(message) {
      error = message;
    },
  });

  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, answer });
}

async function audit(env: Env, sessionId: string) {
  const stub = (await auditor(env, sessionId)) as unknown as {
    listAudit: () => Promise<AuditRow[]>;
  };
  const rows = await stub.listAudit();
  return json({ ok: true, sessionId, rows });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'think-snippets-server-tool-audit-loop',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = path;
    if (request.method === 'POST' && kind === 'chat' && sessionId) return chat(request, env, sessionId);
    if (request.method === 'GET' && kind === 'audit' && sessionId) return audit(env, sessionId);

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
