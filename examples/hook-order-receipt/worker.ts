/**
 * examples/hook-order-receipt
 *
 * One Think Durable Object subclass (`OrderedAssistant`) that overrides every
 * documented chat-turn lifecycle hook and appends an event tag to a SQLite
 * receipt table. A single deterministic server-side tool (`echo`) is exposed
 * and forced via `beforeStep` so every tool-invoking turn produces the same
 * shape of receipt.
 *
 * The example is fully isolated: it never imports from src/worker.ts, never
 * touches the shared Assistant DO, never modifies the shared probe, and is
 * deployed under its own Worker + DO namespace.
 */
import { Think } from '@cloudflare/think';
import type {
  TurnContext,
  TurnConfig,
  PrepareStepContext,
  StepConfig,
  ToolCallContext,
  ToolCallResultContext,
  StepContext,
  ChatResponseResult,
  SubmitMessagesResult,
  ThinkSubmissionInspection,
} from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';
import { tool } from 'ai';
import { z } from 'zod';

export interface Env {
  AI: Ai;
  OrderedAssistant: DurableObjectNamespace<OrderedAssistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

/**
 * Persisted hook receipt event. `seq` is a monotonic, DO-local insertion
 * order — exposed to the probe so it can verify *partial* ordering between
 * related events (same toolCallId, same stepNumber, turn-start vs turn-end)
 * without depending on the unstable interleaving private to Think.
 */
interface ReceiptEvent {
  seq: number;
  hook: string;
  stepNumber: number | null;
  toolCallId: string | null;
  toolName: string | null;
  // JSON blob with hook-specific small fields (no large/sensitive payloads).
  detail: Record<string, unknown>;
  recordedAt: number;
}

const ECHO_TOOL_NAME = 'echo';

export class OrderedAssistant extends Think<Env> {
  override maxSteps = 2;

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  override getSystemPrompt() {
    return [
      'You are the hook-order-receipt verification assistant.',
      'When asked to echo a phrase, call the `echo` tool with exactly that phrase as the `phrase` argument.',
      'Then respond with a single short sentence confirming the echo. No extra prose.',
    ].join(' ');
  }

  override getTools() {
    return {
      [ECHO_TOOL_NAME]: tool({
        description: 'Echo a short phrase back exactly. Deterministic for receipt verification.',
        inputSchema: z.object({
          phrase: z.string().min(1).max(64),
        }),
        async execute({ phrase }) {
          return { echoed: phrase };
        },
      }),
    };
  }

  // -- Lifecycle hooks: each one appends to the receipt --------------------

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this._recordHook({
      hook: 'beforeTurn',
      detail: {
        continuation: ctx.continuation,
        toolNames: Object.keys(ctx.tools).sort(),
        messageCount: ctx.messages.length,
      },
    });
  }

  override async beforeStep(ctx: PrepareStepContext): Promise<StepConfig | void> {
    this._recordHook({
      hook: 'beforeStep',
      stepNumber: ctx.stepNumber,
      detail: {
        priorStepCount: ctx.steps.length,
      },
    });
    // Force the echo tool on step 0 so the turn is deterministic.
    if (ctx.stepNumber === 0) {
      return {
        activeTools: [ECHO_TOOL_NAME],
        toolChoice: { type: 'tool', toolName: ECHO_TOOL_NAME },
      };
    }
    // Subsequent steps: free model, but no tools — produce a short final reply.
    return { activeTools: [] };
  }

  override async beforeToolCall(ctx: ToolCallContext): Promise<void> {
    this._recordHook({
      hook: 'beforeToolCall',
      stepNumber: ctx.stepNumber ?? null,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      detail: {},
    });
  }

  override async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    this._recordHook({
      hook: 'afterToolCall',
      stepNumber: ctx.stepNumber ?? null,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      detail: {
        success: ctx.success,
        durationMsKind: typeof ctx.durationMs === 'number' ? 'number' : 'missing',
      },
    });
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    this._recordHook({
      hook: 'onStepFinish',
      // AI SDK StepResult does not expose a numeric step index; record the
      // number of tool calls + finishReason instead, and leave stepNumber null.
      detail: {
        toolCallCount: ctx.toolCalls?.length ?? 0,
        toolResultCount: ctx.toolResults?.length ?? 0,
        finishReason: ctx.finishReason ?? null,
      },
    });
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    this._recordHook({
      hook: 'onChatResponse',
      detail: {
        status: result.status,
        continuation: result.continuation,
        hasError: Boolean(result.error),
      },
    });
  }

  // -- Receipt storage ------------------------------------------------------

  /**
   * Append one hook event to the per-DO SQLite receipt table. Storage is
   * direct on `ctx.storage.sql`, in a private table prefix so it never
   * collides with Think's own session/workspace tables.
   */
  private _recordHook(input: {
    hook: string;
    stepNumber?: number | null;
    toolCallId?: string | null;
    toolName?: string | null;
    detail: Record<string, unknown>;
  }): void {
    this._ensureReceiptTable();
    this.ctx.storage.sql.exec(
      'INSERT INTO hook_order_receipt (hook, step_number, tool_call_id, tool_name, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.hook,
      input.stepNumber ?? null,
      input.toolCallId ?? null,
      input.toolName ?? null,
      JSON.stringify(input.detail),
      Date.now(),
    );
  }

  private _receiptTableEnsured = false;
  private _ensureReceiptTable(): void {
    if (this._receiptTableEnsured) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS hook_order_receipt (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        hook TEXT NOT NULL,
        step_number INTEGER,
        tool_call_id TEXT,
        tool_name TEXT,
        detail TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )`,
    );
    this._receiptTableEnsured = true;
  }

  /** RPC: return the full ordered receipt for this DO. */
  async getReceipt(): Promise<ReceiptEvent[]> {
    this._ensureReceiptTable();
    const cursor = this.ctx.storage.sql.exec<{
      seq: number;
      hook: string;
      step_number: number | null;
      tool_call_id: string | null;
      tool_name: string | null;
      detail: string;
      recorded_at: number;
    }>('SELECT seq, hook, step_number, tool_call_id, tool_name, detail, recorded_at FROM hook_order_receipt ORDER BY seq ASC');
    const out: ReceiptEvent[] = [];
    for (const row of cursor) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(row.detail) as Record<string, unknown>; } catch { /* keep empty */ }
      out.push({
        seq: row.seq,
        hook: row.hook,
        stepNumber: row.step_number,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        detail: parsed,
        recordedAt: row.recorded_at,
      });
    }
    return out;
  }

  /** RPC: clear the receipt (used by the probe between runs, but not strictly required). */
  async clearReceipt(): Promise<void> {
    this._ensureReceiptTable();
    this.ctx.storage.sql.exec('DELETE FROM hook_order_receipt');
  }
}

// -- HTTP plumbing ----------------------------------------------------------

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function ordered(env: Env, sessionId: string) {
  return getAgentByName(env.OrderedAssistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

async function runTurn(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const phrase = typeof body.phrase === 'string' && body.phrase.length > 0 ? body.phrase : 'hook order works';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
  const userText = `Please echo this phrase using the echo tool: "${phrase}". Then reply: done.`;
  const stub = (await ordered(env, sessionId)) as unknown as {
    clearReceipt: () => Promise<void>;
    submitMessages: (
      messages: ReturnType<typeof userMessage>[],
      options?: { idempotencyKey?: string; metadata?: Record<string, unknown> },
    ) => Promise<SubmitMessagesResult>;
  };
  await stub.clearReceipt();
  const submission = await stub.submitMessages([userMessage(userText)], {
    idempotencyKey,
    metadata: { example: 'hook-order-receipt' },
  });
  return json({ ok: true, sessionId, submission });
}

async function inspect(env: Env, sessionId: string, submissionId: string) {
  const stub = (await ordered(env, sessionId)) as unknown as {
    inspectSubmission: (id: string) => Promise<ThinkSubmissionInspection | null>;
  };
  return json({ ok: true, sessionId, submission: await stub.inspectSubmission(submissionId) });
}

async function receipt(env: Env, sessionId: string) {
  const stub = (await ordered(env, sessionId)) as unknown as {
    getReceipt: () => Promise<ReceiptEvent[]>;
  };
  return json({ ok: true, sessionId, receipt: await stub.getReceipt() });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'hook-order-receipt',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }
    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, action, id] = path;
    if (request.method === 'POST' && kind === 'order' && sessionId && action === 'run') return runTurn(request, env, sessionId);
    if (request.method === 'GET' && kind === 'order' && sessionId && action === 'inspect' && id) return inspect(env, sessionId, id);
    if (request.method === 'GET' && kind === 'order' && sessionId && action === 'receipt') return receipt(env, sessionId);
    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
