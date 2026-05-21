/**
 * Isolated example: latest vs queue message concurrency on @cloudflare/think.
 *
 * Two Durable Objects extend Think with identical configuration *except* the
 * `messageConcurrency` mode:
 *   - `QueueAssistant`  → "queue"  (every overlapping submit-message runs)
 *   - `LatestAssistant` → "latest" (earlier overlapping submits are superseded)
 *
 * Both expose a `slow` tool whose delay is controlled by the user message body
 * (parsed by the model from the prompt) AND by a deterministic `beforeToolCall`
 * substitute that ignores the model's choice and uses a header-provided delay
 * instead. This removes timing flakiness: we no longer trust the model to
 * follow instructions for the delay, we just need it to call `slow`.
 *
 * Concurrency only matters on the WebSocket `cf_agent_use_chat_request` code
 * path (`Think#_handleChatRequest`). `Think.chat()` RPC and `submitMessages()`
 * always go through `_turnQueue.enqueue` sequentially, so the live probe drives
 * the WebSocket protocol directly. Per-request observable signals:
 *   - the response stream's terminal `cf_agent_use_chat_response` frame
 *     (Think emits `body: "" done: true` for superseded turns via
 *     `_completeSkippedRequest`)
 *   - the persisted session history surfaced by `/history/:variant/:session`
 */

import { Think } from '@cloudflare/think';
import type { TurnContext } from '@cloudflare/think';
import { getAgentByName, routeAgentRequest } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

export interface Env {
  AI: Ai;
  QueueAssistant: DurableObjectNamespace<QueueAssistant>;
  LatestAssistant: DurableObjectNamespace<LatestAssistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

const SYSTEM_PROMPT = [
  'You are a deterministic test assistant.',
  'Every user message contains a single ALL-CAPS label like "LABEL=A".',
  'Reply with exactly one short line that includes that label, for example: "done A".',
  'Never call any tools. Never explain. Keep replies to that single line.',
].join('\n');

function buildSlowTool(delayMsRef: { current: number }) {
  // Optional controllable tool delay — kept so a future variant of this example
  // can force the LLM to slow inside the turn itself. The probe relies on the
  // `beforeTurn` sleep below (not on the model choosing to call this tool).
  return tool({
    description: 'Deterministically pause for the per-turn configured delay, then echo the label.',
    inputSchema: z.object({ label: z.string().min(1) }),
    async execute({ label }) {
      const delayMs = delayMsRef.current;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { ok: true, label, delayMs };
    },
  });
}

abstract class BaseAssistant<E extends Env> extends Think<E> {
  protected delayMs = { current: 0 };

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  getTools() {
    return { slow: buildSlowTool(this.delayMs) };
  }

  // Read the per-turn delay from the chat-request custom body (`turnDelayMs`),
  // so the probe can dial in a deterministic gap without depending on model
  // honesty about how long to wait.
  //
  // The delay is applied directly here (not only via the `slow` tool) so the
  // observable overlap window does not depend on the LLM actually choosing to
  // call the tool — it is enforced at the framework boundary right after the
  // turn enters the inference loop and before any model call. This is the
  // "controllable hook" the example needs to avoid timing-only flakiness.
  override async beforeTurn(ctx: TurnContext): Promise<void> {
    const raw = ctx.body?.turnDelayMs;
    const next = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    this.delayMs.current = next;
    if (next > 0) await new Promise((resolve) => setTimeout(resolve, next));
  }
}

export class QueueAssistant extends BaseAssistant<Env> {
  override messageConcurrency = 'queue' as const;
}

export class LatestAssistant extends BaseAssistant<Env> {
  override messageConcurrency = 'latest' as const;
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

type Variant = 'queue' | 'latest';

function namespaceFor(env: Env, variant: string): DurableObjectNamespace<BaseAssistant<Env>> | null {
  if (variant === 'queue') return env.QueueAssistant as unknown as DurableObjectNamespace<BaseAssistant<Env>>;
  if (variant === 'latest') return env.LatestAssistant as unknown as DurableObjectNamespace<BaseAssistant<Env>>;
  return null;
}

async function getAssistant(env: Env, variant: Variant, sessionId: string) {
  const ns = namespaceFor(env, variant);
  if (!ns) return null;
  return getAgentByName(ns, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function readHistory(env: Env, variant: Variant, sessionId: string) {
  const stub = (await getAssistant(env, variant, sessionId)) as unknown as
    | { getMessages: () => Promise<unknown[]> }
    | null;
  if (!stub) return null;
  return stub.getMessages();
}

async function clearHistory(env: Env, variant: Variant, sessionId: string) {
  const stub = (await getAssistant(env, variant, sessionId)) as unknown as
    | { clearMessages: () => Promise<void> }
    | null;
  if (!stub) return;
  await stub.clearMessages();
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'concurrency-latest-vs-queue',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    // GET /history/:variant/:session
    if (request.method === 'GET' && parts[0] === 'history' && parts[1] && parts[2]) {
      const messages = await readHistory(env, parts[1] as Variant, parts[2]);
      if (messages === null) return json({ ok: false, error: 'unknown variant' }, { status: 400 });
      return json({ ok: true, variant: parts[1], sessionId: parts[2], messages });
    }
    // POST /clear/:variant/:session
    if (request.method === 'POST' && parts[0] === 'clear' && parts[1] && parts[2]) {
      const variant = parts[1] as Variant;
      if (variant !== 'queue' && variant !== 'latest') return json({ ok: false, error: 'unknown variant' }, { status: 400 });
      await clearHistory(env, variant, parts[2]);
      return json({ ok: true });
    }

    // Hand WebSocket + agent HTTP traffic to Think via routeAgentRequest.
    // Default prefix is `agents` → /agents/:agent/:room.
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
