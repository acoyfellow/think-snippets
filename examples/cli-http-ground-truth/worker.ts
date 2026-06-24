import { Think } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

// Isolated example: a Think agent whose source of truth is a real Cloudflare
// CLI ("cf"), exposed over HTTP.
//
// The CLI is NOT a fixture. `cf <command>` runs the actual Cloudflare API
// against the deploying account using the bound token, so its stdout is live
// account state that neither the model nor this repo authored. The agent has
// one tool, `run_cf`, which shells out to the CLI service and must report its
// stdout verbatim. The probe independently calls the same Cloudflare API and
// asserts the agent's answer matches reality — a wrong/hallucinated answer
// genuinely fails because the truth is the account, not a planted string.

export interface Env {
  AI: Ai;
  CliAgent: DurableObjectNamespace<CliAgent>;
  // Real Cloudflare credentials, scoped to the deploying (personal) account.
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
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

interface CfResult {
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

const CF_API = 'https://api.cloudflare.com/client/v4';

// The real `cf` CLI. Each subcommand maps to a genuine Cloudflare API call.
// Output is whatever the live account returns — not a fixture.
async function runCf(command: string, env: Env): Promise<CfResult> {
  const [name, ...rest] = command.trim().split(/\s+/);
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };

  async function api(path: string) {
    const res = await fetch(`${CF_API}${path}`, { headers });
    const json = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown };
    return { ok: res.ok && json.success !== false, json };
  }

  try {
    switch (name) {
      case 'whoami': {
        const { ok, json } = await api('/user/tokens/verify');
        const r = (json.result ?? {}) as { status?: string };
        return ok
          ? { exitCode: 0, stdout: `token: ${r.status ?? 'unknown'}\naccount: ${env.CF_ACCOUNT_ID}`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `cf: whoami failed: ${JSON.stringify(json.errors)}` };
      }
      case 'account': {
        const { ok, json } = await api(`/accounts/${env.CF_ACCOUNT_ID}`);
        const r = (json.result ?? {}) as { name?: string; id?: string };
        return ok
          ? { exitCode: 0, stdout: `name: ${r.name ?? ''}\nid: ${r.id ?? ''}`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `cf: account failed: ${JSON.stringify(json.errors)}` };
      }
      case 'workers': {
        if (rest[0] !== 'list') {
          return { exitCode: 2, stdout: '', stderr: `cf: unknown workers subcommand: ${rest[0] ?? ''}` };
        }
        const { ok, json } = await api(`/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`);
        const scripts = (json.result ?? []) as Array<{ id?: string }>;
        return ok
          ? { exitCode: 0, stdout: `count: ${scripts.length}`, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `cf: workers list failed: ${JSON.stringify(json.errors)}` };
      }
      default:
        return { exitCode: 127, stdout: '', stderr: `cf: command not found: ${name}` };
    }
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: `cf: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const runCfInput = z.object({
  command: z
    .string()
    .min(1)
    .max(120)
    .describe('A cf CLI command line, e.g. "account", "whoami", or "workers list".'),
});

export class CliAgent extends Think<Env> {
  private _auditReady = false;

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
      'You are a Cloudflare operations agent whose ONLY source of truth is the',
      '`run_cf` tool, which runs a real `cf` CLI against the live account.',
      'Never guess account state. To answer any question, call `run_cf` with the',
      'right command and report its stdout exactly. The CLI output is ground truth.',
    ].join(' ');
  }

  private ensureAudit() {
    if (this._auditReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cf_audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL, command TEXT NOT NULL,
         exit_code INTEGER NOT NULL, stdout TEXT NOT NULL )`,
    );
    this._auditReady = true;
  }

  override getTools() {
    return {
      run_cf: tool({
        description:
          'Run a command against the real Cloudflare `cf` CLI and return its stdout/stderr/exit code. This is the only source of truth about the account.',
        inputSchema: runCfInput,
        execute: async ({ command }) => {
          const origin = await this.cliOrigin();
          const res = await fetch(`${origin}/cf`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command }),
          });
          const result = (await res.json()) as CfResult;
          this.ensureAudit();
          this.ctx.storage.sql.exec(
            'INSERT INTO cf_audit (ts, command, exit_code, stdout) VALUES (?, ?, ?, ?)',
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

  async listAudit(): Promise<AuditRow[]> {
    this.ensureAudit();
    const rows = this.ctx.storage.sql
      .exec('SELECT id, ts, command, exit_code, stdout FROM cf_audit ORDER BY id ASC')
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
  const message =
    typeof body.message === 'string' ? body.message : 'What is this account name? Use the cf CLI.';
  const stub = (await agentStub(env, sessionId)) as unknown as {
    chat: (m: string, cb: StreamCallback) => Promise<void>;
    setOrigin: (o: string) => Promise<void>;
  };
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

    // The real cf CLI service. The agent's run_cf tool calls this.
    if (url.pathname === '/cf' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { command?: string };
      return json(await runCf(body.command ?? '', env));
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = parts;
    if (request.method === 'POST' && kind === 'chat' && sessionId) return chat(request, env, sessionId, origin);
    if (request.method === 'GET' && kind === 'audit' && sessionId) return audit(env, sessionId);

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
