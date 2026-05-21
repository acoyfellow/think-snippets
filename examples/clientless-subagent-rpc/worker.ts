import { Think } from '@cloudflare/think';
import { Agent, getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

// Isolated example: clientless parent agent invokes a Think child sub-agent
// over raw Durable Object RPC.
//
// No React, no chat UI, no SSE. The HTTP surface is JSON only and exists
// purely to drive the live probe. What this example exists to prove:
//
//   1. The parent Agent can call `child.chat()` over DO RPC and receive
//      streamed `text-delta` chunks via a `StreamCallback` RpcTarget —
//      i.e. the documented raw sub-agent RPC contract works end-to-end.
//   2. Each child session is a *separate* Think DO with isolated SQLite
//      state — facts taught to session A are not visible to session B
//      even when both children are reached from the same parent.
//   3. The parent assembles the streamed child output into a single
//      response, returns observable streaming counters (chunks > 0), and
//      reports how many messages the child has durably persisted.
//
// Deliberately *not* doing:
//   - Wrapping the child as an `agentTool` (that is the agents-as-tools UI
//     surface and lives in a different example).
//   - Driving the child through Think's `submitMessages` durable queue
//     (covered by examples/durable-submit).
//   - Any client/browser code.

export interface Env {
  AI: Ai;
  Parent: DurableObjectNamespace<Parent>;
  Child: DurableObjectNamespace<Child>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface StreamCallback {
  onEvent: (json: string) => void | Promise<void>;
  onDone?: () => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
}

/**
 * Child sub-agent. A native Think DO with isolated SQLite-backed memory.
 * Each unique session name resolves to its own DO instance with its own
 * conversation history.
 */
export class Child extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a clientless Think sub-agent invoked over raw RPC by a parent agent.',
      'When the user tells you to remember an exact word, store it in conversational context.',
      'When asked to recall it, answer with that single word only.',
      'If you have never been told a word, answer literally: unknown.',
    ].join(' ');
  }
}

/**
 * Parent agent. A plain `agents` Agent — not a Think — so this example is
 * unambiguously about a parent agent driving a Think *child* over raw RPC,
 * not two Think agents talking to each other.
 *
 * `delegate()` is the raw RPC contract under test: pick a child by name,
 * call `child.chat()`, collect the streamed text-delta chunks, and return
 * a parent-level response.
 */
export class Parent extends Agent<Env> {
  /**
   * Invoke a Think child sub-agent over raw DO RPC and aggregate its
   * streamed answer. Returns parent-level diagnostics (chunkCount,
   * gotTextDelta) so the live probe can assert streaming actually
   * happened — a non-streaming child stub would return chunkCount=0.
   */
  async delegate(
    childSessionId: string,
    userMessage: string,
  ): Promise<{
    parent: { id: string };
    child: { sessionId: string; messageCount: number };
    streaming: { chunkCount: number; textDeltaCount: number };
    answer: string;
    error?: string;
  }> {
    const child = (await getAgentByName(this.env.Child, childSessionId, {
      routingRetry: { maxAttempts: 3 },
    })) as unknown as {
      chat: (msg: string, cb: StreamCallback) => Promise<void>;
      getMessages: () => Promise<unknown[]> | unknown[];
    };

    let answer = '';
    let chunkCount = 0;
    let textDeltaCount = 0;
    let streamError: string | undefined;

    // RpcTarget-style callback object. The child Worker reaches back into
    // this object across the RPC boundary to emit streamed events.
    const callback: StreamCallback = {
      onEvent: (raw) => {
        chunkCount += 1;
        try {
          const chunk = JSON.parse(raw) as UIMessageChunk;
          if (chunk.type === 'text-delta') {
            textDeltaCount += 1;
            answer += chunk.delta ?? chunk.text ?? '';
          }
        } catch {
          // Think emits non-JSON control frames as well; they carry no
          // assistant text but still count as evidence of streaming.
        }
      },
      onDone: () => {
        // Acknowledge stream completion. No-op for the JSON contract.
      },
      onError: (message) => {
        streamError = message;
      },
    };

    await child.chat(userMessage, callback);

    const messages = (await child.getMessages()) ?? [];
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    return {
      parent: { id: 'parent-' + (this.name ?? 'unknown') },
      child: { sessionId: childSessionId, messageCount },
      streaming: { chunkCount, textDeltaCount },
      answer,
      error: streamError,
    };
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function readBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function parentStub(env: Env, parentId: string) {
  return getAgentByName(env.Parent, parentId, { routingRetry: { maxAttempts: 3 } });
}

async function childStub(env: Env, childSessionId: string) {
  return getAgentByName(env.Child, childSessionId, { routingRetry: { maxAttempts: 3 } });
}

async function runDelegate(request: Request, env: Env, parentId: string) {
  const body = await readBody(request);
  const childSessionId =
    typeof body.childSessionId === 'string' && body.childSessionId.length > 0
      ? body.childSessionId
      : `${parentId}-child-default`;
  const message = typeof body.message === 'string' ? body.message : 'Hello.';

  const parent = (await parentStub(env, parentId)) as unknown as {
    delegate: Parent['delegate'];
  };
  const result = await parent.delegate(childSessionId, message);
  if (result.error) return jsonResponse({ ok: false, ...result }, { status: 502 });
  return jsonResponse({ ok: true, ...result });
}

async function inspectChild(env: Env, childSessionId: string) {
  const child = (await childStub(env, childSessionId)) as unknown as {
    getMessages: () => Promise<unknown[]> | unknown[];
  };
  const messages = (await child.getMessages()) ?? [];
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  return jsonResponse({ ok: true, childSessionId, messageCount });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        example: 'clientless-subagent-rpc',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, id] = parts;

    if (request.method === 'POST' && kind === 'delegate' && id) {
      return runDelegate(request, env, id);
    }
    if (request.method === 'GET' && kind === 'child' && id) {
      return inspectChild(env, id);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
