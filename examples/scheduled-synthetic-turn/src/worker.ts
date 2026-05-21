import { Think } from '@cloudflare/think';
import type { UIMessage } from 'ai';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

export interface Env {
  AI: Ai;
  ScheduledAssistant: DurableObjectNamespace<ScheduledAssistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface SyntheticTurnPayload {
  prompt: string;
  triggeredAt: number;
}

/**
 * ScheduledAssistant proves the server-triggered path: no client WebSocket /
 * chat RPC is involved. A POST request enqueues a near-immediate Agent
 * `schedule()` row (delay 1s, deterministic — does not wait on real cron).
 * When the DO alarm fires, `runSyntheticTurn()` calls Think `saveMessages()`,
 * which injects a synthetic user message into the conversation and triggers
 * a real model turn against `@cf/moonshotai/kimi-k2.6`. The probe then polls
 * persisted history via `getMessages()` until the assistant reply appears.
 */
export class ScheduledAssistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a scheduled-trigger Project Think assistant.',
      'When you receive a synthetic user prompt, answer it plainly.',
      'Preserve provided facts verbatim so a later inspection can verify the synthetic turn ran.',
    ].join(' ');
  }

  /**
   * Schedule a synthetic user turn ~1s in the future. This is exposed as
   * an RPC method so the Worker fetch handler can enqueue server-driven
   * work without holding the request open. The returned schedule id lets
   * the probe correlate the trigger with the eventual history row.
   */
  async triggerScheduled(prompt: string): Promise<{ scheduleId: string; runsInMs: number }> {
    const payload: SyntheticTurnPayload = { prompt, triggeredAt: Date.now() };
    // Delay 1s — deterministic and does not wait on real cron.
    // `schedule(seconds, callbackName, payload)` is supported by the Agents
    // base class and persists the alarm row in the DO's SQLite store.
    const schedule = await this.schedule<SyntheticTurnPayload>(1, 'runSyntheticTurn', payload);
    return { scheduleId: schedule.id, runsInMs: 1000 };
  }

  /**
   * Alarm-driven callback. Receives the payload originally passed to
   * `this.schedule()`. Injects a synthetic user message via Think
   * `saveMessages()`, which both persists the message and triggers a
   * programmatic model turn — the same path documented for scheduled
   * responses, webhook-triggered turns, and proactive agents.
   */
  async runSyntheticTurn(payload: SyntheticTurnPayload): Promise<void> {
    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: payload.prompt }],
    };
    await this.saveMessages([userMessage]);
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function assistant(env: Env, sessionId: string) {
  return getAgentByName(env.ScheduledAssistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function trigger(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const prompt =
    typeof body.prompt === 'string'
      ? body.prompt
      : 'Synthetic scheduled turn — reply with exactly: scheduled turn observed.';
  const stub = (await assistant(env, sessionId)) as unknown as {
    triggerScheduled: (prompt: string) => Promise<{ scheduleId: string; runsInMs: number }>;
  };
  const result = await stub.triggerScheduled(prompt);
  return json({ ok: true, sessionId, ...result });
}

async function history(env: Env, sessionId: string) {
  const stub = (await assistant(env, sessionId)) as unknown as {
    getMessages: () => Promise<UIMessage[]>;
  };
  // getMessages() is a regular method; over RPC it returns a serialisable array.
  const messages = await stub.getMessages();
  return json({ ok: true, sessionId, count: messages.length, messages });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'scheduled-synthetic-turn',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = path;
    if (request.method === 'POST' && kind === 'trigger' && sessionId) return trigger(request, env, sessionId);
    if (request.method === 'GET' && kind === 'history' && sessionId) return history(env, sessionId);

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
