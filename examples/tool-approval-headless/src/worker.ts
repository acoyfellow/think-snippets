// Headless tool-approval flow for a Think-hosted sensitive tool.
//
// Design (server-enforced; see README for caveat):
//   - One sensitive tool: `transfer_funds`. It has an `execute` (so Think's
//     `beforeToolCall` hook can intercept), but its real effect is only
//     reached after passing approval-table validation.
//   - Approval state is durable in DO SQLite (one Approvals row per ticket).
//     A ticket has status "pending" | "approved" | "denied" and a `used` flag.
//   - `beforeToolCall` is the single enforcement point:
//       - missing/unknown ticket            -> block (denied: unknown_ticket)
//       - status !== "approved"             -> block (denied: <status>)
//       - already used                      -> block (denied: already_used)
//       - otherwise                         -> allow, then mark used
//     Every decision is appended to a durable Audit table before the tool runs.
//   - The DO forces the model to call exactly this tool on the gated turn via
//     `beforeTurn -> { activeTools, toolChoice }` so the headless probe doesn't
//     depend on the model spontaneously choosing the tool. The model is still
//     in the loop — Think performs the streamText + tool-call cycle — but the
//     server controls *which* tool runs and *whether* it runs.
//
// What the live probe proves (no human, no UI):
//   1. Denial path: request a transfer with a ticket whose status is "denied".
//      Audit shows decision="denied", reason="denied", and the side-effect
//      counter did not increment.
//   2. No-approval path: request a transfer with a ticket nobody created.
//      Audit shows decision="denied", reason="unknown_ticket", side-effect
//      counter did not increment.
//   3. Approved path: create ticket -> approve -> request a transfer with that
//      ticket. Audit shows decision="executed" exactly once. Side-effect
//      counter incremented by exactly one. A second submission re-using the
//      same ticket is blocked with reason="already_used"; counter unchanged.

import { Think } from '@cloudflare/think';
import type { SubmitMessagesResult } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

export interface Env {
  AI: Ai;
  Approver: DurableObjectNamespace<Approver>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

type ApprovalStatus = 'pending' | 'approved' | 'denied';

interface ApprovalRow {
  ticket: string;
  status: ApprovalStatus;
  used: number;
  createdAt: number;
  decidedAt: number | null;
}

interface AuditRow {
  id: number;
  ts: number;
  ticket: string | null;
  toolName: string;
  decision: 'executed' | 'denied';
  reason: string;
  inputJson: string;
}

interface SideEffectState {
  counter: number;
  lastTicket: string | null;
  lastAt: number | null;
}

const SENSITIVE_TOOL = 'transfer_funds';

export class Approver extends Think<Env> {
  private tablesReady = false;

  private ensureTables() {
    if (this.tablesReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS approvals (
         ticket TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         used INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         decided_at INTEGER
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,
         ticket TEXT,
         tool_name TEXT NOT NULL,
         decision TEXT NOT NULL,
         reason TEXT NOT NULL,
         input_json TEXT NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS side_effect (
         k TEXT PRIMARY KEY,
         counter INTEGER NOT NULL,
         last_ticket TEXT,
         last_at INTEGER
       )`,
    );
    sql.exec(
      `INSERT OR IGNORE INTO side_effect (k, counter, last_ticket, last_at) VALUES ('singleton', 0, NULL, NULL)`,
    );
    this.tablesReady = true;
  }

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a transfer agent operating under a strict server-enforced approval policy.',
      `When the user asks you to transfer funds, you MUST call the ${SENSITIVE_TOOL} tool exactly once.`,
      'Always pass the approvalTicket value the user gave you, verbatim, in the tool call.',
      'Do not invent or alter the approvalTicket. Never call any other tool.',
    ].join(' ');
  }

  // Force the gated turn to call only the sensitive tool. This removes
  // model-choice non-determinism from the headless probe; enforcement still
  // happens server-side in beforeToolCall.
  override beforeTurn() {
    return {
      activeTools: [SENSITIVE_TOOL],
      toolChoice: { type: 'tool', toolName: SENSITIVE_TOOL } as const,
      maxSteps: 2,
    };
  }

  override getTools() {
    return {
      [SENSITIVE_TOOL]: tool({
        description:
          'Sensitive: transfer funds. Server-enforced approval required. Pass the approvalTicket the user provided.',
        inputSchema: z.object({
          approvalTicket: z.string().describe('Opaque approval ticket the user supplied verbatim.'),
          amount: z.number().positive().describe('Amount to transfer.'),
          to: z.string().describe('Destination account label.'),
        }),
        execute: async (input) => {
          // Reachable only when beforeToolCall returned action: "allow".
          this.ensureTables();
          const sql = this.ctx.storage.sql;
          sql.exec(
            `UPDATE side_effect
               SET counter = counter + 1,
                   last_ticket = ?,
                   last_at = ?
             WHERE k = 'singleton'`,
            input.approvalTicket,
            Date.now(),
          );
          sql.exec(
            `UPDATE approvals SET used = 1 WHERE ticket = ?`,
            input.approvalTicket,
          );
          return {
            ok: true,
            ticket: input.approvalTicket,
            transferred: input.amount,
            to: input.to,
          };
        },
      }),
    };
  }

  override async beforeToolCall(ctx: import('@cloudflare/think').ToolCallContext) {
    this.ensureTables();
    if (ctx.toolName !== SENSITIVE_TOOL) return; // allow non-sensitive tools (none configured here)
    const raw = (ctx.input ?? {}) as Record<string, unknown>;
    const ticket = typeof raw.approvalTicket === 'string' ? raw.approvalTicket : null;

    const decide = (decision: 'executed' | 'denied', reason: string) => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `INSERT INTO audit (ts, ticket, tool_name, decision, reason, input_json) VALUES (?, ?, ?, ?, ?, ?)`,
        Date.now(),
        ticket,
        ctx.toolName,
        decision,
        reason,
        JSON.stringify(raw),
      );
    };

    if (!ticket) {
      decide('denied', 'missing_ticket');
      return { action: 'block' as const, reason: 'denied: missing approval ticket' };
    }
    const row = this.lookupApproval(ticket);
    if (!row) {
      decide('denied', 'unknown_ticket');
      return { action: 'block' as const, reason: `denied: unknown approval ticket ${ticket}` };
    }
    if (row.status !== 'approved') {
      decide('denied', row.status);
      return { action: 'block' as const, reason: `denied: ticket status is ${row.status}` };
    }
    if (row.used) {
      decide('denied', 'already_used');
      return { action: 'block' as const, reason: 'denied: approval ticket already used' };
    }
    decide('executed', 'approved');
    return { action: 'allow' as const };
  }

  private lookupApproval(ticket: string): ApprovalRow | null {
    this.ensureTables();
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<{
        ticket: string;
        status: ApprovalStatus;
        used: number;
        created_at: number;
        decided_at: number | null;
      }>(`SELECT ticket, status, used, created_at, decided_at FROM approvals WHERE ticket = ?`, ticket)
      .toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      ticket: r.ticket,
      status: r.status,
      used: r.used,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    };
  }

  // ---- RPC surface used by the Worker fetch handler ----

  async createTicket(ticket: string): Promise<ApprovalRow> {
    this.ensureTables();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO approvals (ticket, status, used, created_at, decided_at) VALUES (?, 'pending', 0, ?, NULL)`,
      ticket,
      now,
    );
    const row = this.lookupApproval(ticket);
    if (!row) throw new Error('failed to create ticket');
    return row;
  }

  async decide(ticket: string, status: 'approved' | 'denied'): Promise<ApprovalRow | null> {
    this.ensureTables();
    const sql = this.ctx.storage.sql;
    sql.exec(
      `UPDATE approvals SET status = ?, decided_at = ? WHERE ticket = ?`,
      status,
      Date.now(),
      ticket,
    );
    return this.lookupApproval(ticket);
  }

  async getAudit(): Promise<AuditRow[]> {
    this.ensureTables();
    return this.ctx.storage.sql
      .exec<{
        id: number;
        ts: number;
        ticket: string | null;
        tool_name: string;
        decision: 'executed' | 'denied';
        reason: string;
        input_json: string;
      }>(`SELECT id, ts, ticket, tool_name, decision, reason, input_json FROM audit ORDER BY id ASC`)
      .toArray()
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        ticket: r.ticket,
        toolName: r.tool_name,
        decision: r.decision,
        reason: r.reason,
        inputJson: r.input_json,
      }));
  }

  async getSideEffect(): Promise<SideEffectState> {
    this.ensureTables();
    const r = this.ctx.storage.sql
      .exec<{ counter: number; last_ticket: string | null; last_at: number | null }>(
        `SELECT counter, last_ticket, last_at FROM side_effect WHERE k = 'singleton'`,
      )
      .toArray()[0];
    return {
      counter: r?.counter ?? 0,
      lastTicket: r?.last_ticket ?? null,
      lastAt: r?.last_at ?? null,
    };
  }
}

// ---------- HTTP wiring ----------

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function stub(env: Env, sessionId: string) {
  return getAgentByName(env.Approver, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

type ApproverRpc = {
  createTicket: (ticket: string) => Promise<ApprovalRow>;
  decide: (ticket: string, status: 'approved' | 'denied') => Promise<ApprovalRow | null>;
  getAudit: () => Promise<AuditRow[]>;
  getSideEffect: () => Promise<SideEffectState>;
  submitMessages: (
    messages: ReturnType<typeof userMessage>[],
    options?: { idempotencyKey?: string; metadata?: Record<string, unknown> },
  ) => Promise<SubmitMessagesResult>;
  inspectSubmission: (id: string) => Promise<{ status?: string } | null>;
};

async function createTicket(env: Env, sessionId: string, ticket: string) {
  const s = (await stub(env, sessionId)) as unknown as ApproverRpc;
  const row = await s.createTicket(ticket);
  return json({ ok: true, sessionId, approval: row });
}

async function decideTicket(
  env: Env,
  sessionId: string,
  ticket: string,
  status: 'approved' | 'denied',
) {
  const s = (await stub(env, sessionId)) as unknown as ApproverRpc;
  const row = await s.decide(ticket, status);
  return json({ ok: true, sessionId, approval: row });
}

async function runTransfer(request: Request, env: Env, sessionId: string) {
  const body = await readBody(request);
  const ticket = String(body.approvalTicket ?? '');
  const amount = typeof body.amount === 'number' ? body.amount : 25;
  const to = typeof body.to === 'string' ? body.to : 'savings';
  const idempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey : `req-${ticket}-${Date.now()}`;

  const s = (await stub(env, sessionId)) as unknown as ApproverRpc;
  const text = [
    `Transfer $${amount} to ${to}.`,
    `Use approvalTicket exactly: "${ticket}".`,
    `Call ${SENSITIVE_TOOL} once. Pass approvalTicket="${ticket}", amount=${amount}, to="${to}".`,
  ].join(' ');
  const submission = await s.submitMessages([userMessage(text)], {
    idempotencyKey,
    metadata: { example: 'tool-approval-headless', ticket, amount, to },
  });
  return json({ ok: true, sessionId, submission });
}

async function inspect(env: Env, sessionId: string, submissionId: string) {
  const s = (await stub(env, sessionId)) as unknown as ApproverRpc;
  return json({ ok: true, sessionId, submission: await s.inspectSubmission(submissionId) });
}

async function audit(env: Env, sessionId: string) {
  const s = (await stub(env, sessionId)) as unknown as ApproverRpc;
  const [auditRows, sideEffect] = await Promise.all([s.getAudit(), s.getSideEffect()]);
  return json({ ok: true, sessionId, audit: auditRows, sideEffect });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'tool-approval-headless',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, action, id] = parts;

    if (request.method === 'POST' && kind === 'approval' && sessionId && action === 'create' && id) {
      return createTicket(env, sessionId, id);
    }
    if (request.method === 'POST' && kind === 'approval' && sessionId && action === 'approve' && id) {
      return decideTicket(env, sessionId, id, 'approved');
    }
    if (request.method === 'POST' && kind === 'approval' && sessionId && action === 'deny' && id) {
      return decideTicket(env, sessionId, id, 'denied');
    }
    if (request.method === 'POST' && kind === 'transfer' && sessionId) {
      return runTransfer(request, env, sessionId);
    }
    if (request.method === 'GET' && kind === 'transfer' && sessionId && action === 'inspect' && id) {
      return inspect(env, sessionId, id);
    }
    if (request.method === 'GET' && kind === 'audit' && sessionId) {
      return audit(env, sessionId);
    }

    return json({ ok: false, error: 'Not found', path: url.pathname }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
