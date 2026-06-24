import { Think } from '@cloudflare/think';
import type { ToolCallResultContext } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

// Isolated example: "my CLI is the ground truth."
//
// Frank's ask (paraphrased): run an agent on Cloudflare that treats a custom
// CLI as its source of truth for doing tasks. This is the HTTP/RPC flavor:
// the "CLI" is a tiny command service the Worker hosts (`/cli`). The Think
// agent has ONE tool — `run_cli` — that shells out to that service over HTTP
// and must report the service's stdout verbatim. The probe seeds a command
// whose stdout carries a runtime-only token the model cannot have invented,
// then proves the token reached the assistant answer AND that the tool call
// was durably audited.

export interface Env {
  AI: Ai;
  CliAgent: DurableObjectNamespace<CliAgent>;
  // The CLI service shares this Worker; the agent calls it over its own URL.
  SELF_ORIGIN?: string;
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

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AuditRow {
  id: number;
  ts: number;
  command: string;
  exitCode: number;
  stdout: string;
}

const runCliInput = z.object({
  command: z.string().min(1).max(200).describe('The CLI command line to execute, e.g. "status".'),
});

// ---------------------------------------------------------------------------
// The "CLI service". In a real deployment this is the user's own CLI exposed
// over HTTP/RPC; here it is a deterministic in-Worker command registry so the
// example is self-contained and the probe can seed a runtime-only token.
// ---------------------------------------------------------------------------
const cliRegistry = new Map<string, (token: string) => CliResult>([
  [
    'status',
    (token) => ({
      exitCode: 0,
      stdout: `service: ok\nbuild: ${token}\nuptime: 42s`,
      stderr: '',
    }),
  ],
  [
    'version',
    (token) => ({ exitCode: 0, stdout: `mycli 1.0.0+${token}`, stderr: '' }),
  ],
]);

function runCliCommand(command: string, token: string): CliResult {
  const name = command.trim().split(/\s+/)[0] ?? '';
  const handler = cliRegistry.get(name);
  if (!handler) {
    return { exitCode: 127, stdout: '', stderr: `mycli: command not found: ${name}` };
  }
  return handler(token);
}

export class CliAgent extends Think<Env> {
  private _auditReady = false;

  // The agent must know its own Worker origin to reach the /cli service.
  // env mutations in the top-level fetch handler do NOT propagate into the
  // DO's env snapshot, so the origin is set explicitly over RPC and persisted.
  async setOrigin(origin: string): Promise<void> {
    await this.ctx.storage.put('cliOrigin', origin);
  }

  private async cliOrigin(): Promise<string> {
    return (await this.ctx.storage.get<string>('cliOrigin')) ?? this.env.SELF_ORIGIN ?? '';
  }

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are an operations agent whose ONLY source of truth is the `run_cli` tool.',
      'You must never guess command output. To answer any question about the',
      'system, call `run_cli` with the appropriate command and report its stdout',
      'exactly. Treat the CLI stdout as authoritative ground truth.',
    ].join(' ');
  }

  private ensureAudit() {
    if (this._auditReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cli_audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,
         command TEXT NOT NULL,
         exit_code INTEGER NOT NULL,
         stdout TEXT NOT NULL
       )`,
    );
    this._auditReady = true;
  }

  override getTools() {
    return {
      run_cli: tool({
        description:
          'Run a command against the operator CLI service and return its stdout, stderr, and exit code. This is the only source of truth.',
        inputSchema: runCliInput,
        execute: async ({ command }) => {
          // Shell out to the CLI service over HTTP — exactly how a real agent
          // would invoke an external CLI exposed as a service.
          const origin = await this.cliOrigin();
          const res = await fetch(`${origin}/cli`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command }),
          });
          const result = (await res.json()) as CliResult;
          this.ensureAudit();
          this.ctx.storage.sql.exec(
            'INSERT INTO cli_audit (ts, command, exit_code, stdout) VALUES (?, ?, ?, ?)',
            Date.now(),
            command,
            result.exitCode,
            result.stdout,
          );
          return result;
        },
      }),
    };
  }

  override afterToolCall(_ctx: ToolCallResultContext): void {
    // Audit is written inside execute() so it captures the real CLI output.
  }

  // RPC: list audit rows so the probe can prove the tool actually ran.
  async listAudit(): Promise<AuditRow[]> {
    this.ensureAudit();
    const rows = this.ctx.storage.sql
      .exec('SELECT id, ts, command, exit_code, stdout FROM cli_audit ORDER BY id ASC')
      .toArray() as unknown as Array<{
      id: number;
      ts: number;
      command: string;
      exit_code: number;
      stdout: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      command: r.command,
      exitCode: r.exit_code,
      stdout: r.stdout,
    }));
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function agentStub(env: Env, sessionId: string) {
  return getAgentByName(env.CliAgent, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function chat(request: Request, env: Env, sessionId: string, origin: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : 'What is the build id? Use the CLI.';
  const stub = (await agentStub(env, sessionId)) as unknown as {
    chat: (m: string, cb: StreamCallback) => Promise<void>;
    setOrigin: (o: string) => Promise<void>;
  };
  // Tell the agent its own origin so the run_cli tool can reach /cli.
  await stub.setOrigin(origin);
  let answer = '';
  let error: string | undefined;
  await stub.chat(message, {
    onStart() {},
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        /* control frame */
      }
    },
    onDone() {},
    onError(m) {
      error = m;
    },
  });
  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, answer });
}

async function audit(env: Env, sessionId: string) {
  const stub = (await agentStub(env, sessionId)) as unknown as { listAudit: () => Promise<AuditRow[]> };
  return json({ ok: true, sessionId, audit: await stub.listAudit() });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'cli-http-ground-truth',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    // The CLI service endpoint. The agent's run_cli tool calls this.
    // The token is deterministic per deploy (derived from the account id) so
    // every isolate agrees, while still being a value the model cannot have
    // memorized from training — proving it used the CLI, not a guess.
    if (url.pathname === '/cli' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { command?: string };
      return json(runCliCommand(body.command ?? '', cliToken(env)));
    }

    // Probe helper: reveal the deploy CLI token so the probe knows the exact
    // ground-truth string to look for in the agent's answer.
    if (url.pathname === '/cli-token') {
      return json({ token: cliToken(env) });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = parts;
    if (request.method === 'POST' && kind === 'chat' && sessionId) return chat(request, env, sessionId, origin);
    if (request.method === 'GET' && kind === 'audit' && sessionId) return audit(env, sessionId);

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Deploy-stable token: deterministic across all isolates of this deploy so
// the /cli-token reveal and the agent's run_cli output always agree, yet
// unguessable (derived from the per-account deploy id) so an answer that
// contains it proves the model actually called the CLI.
function cliToken(env: Env): string {
  const seed = env.DEPLOY_ACCOUNT_ID ?? 'local';
  // Tiny stable hash -> 8 hex chars.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
