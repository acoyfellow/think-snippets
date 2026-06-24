import { Think } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

// Isolated example: native HTTP -> Think.chat() RPC bridge.
//
// This Worker exists only to prove that multiple HTTP requests targeting the
// same Durable Object session see the streamed RPC turns of earlier requests
// — i.e. Think persists conversational state in DO SQLite across requests
// even when those requests are independent stateless fetches from the edge.

export interface Env {
  AI: Ai;
  Memory: DurableObjectNamespace<Memory>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface StreamCallback {
  // think >=0.10 requires onStart(event) at the head of the stream contract
  // (onStart -> onEvent* -> onDone|onError). onInterrupted is optional.
  onStart: (event: unknown) => void;
  onEvent: (json: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export class Memory extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a verifiable Think memory probe.',
      'When the user asks you to remember an exact word, store it in conversational context.',
      'When asked to recall it, answer with that single word and nothing else.',
    ].join(' ');
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function memoryStub(env: Env, sessionId: string) {
  // Bare DO RPC does not await PartyServer/Agents onStart(). getAgentByName()
  // synchronizes initialization before user RPC methods like Think.chat() run.
  return getAgentByName(env.Memory, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function readBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function chatTurn(request: Request, env: Env, sessionId: string) {
  const body = await readBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Hello.';
  const stub = (await memoryStub(env, sessionId)) as unknown as {
    chat: (userMessage: string, callback: StreamCallback) => Promise<void>;
  };

  let answer = '';
  let streamError: string | undefined;

  await stub.chat(message, {
    onStart() {
      // Stream opened; nothing to do for this headless bridge.
    },
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        // Think emits non-JSON control frames as well; they carry no answer text.
      }
    },
    onDone() {
      // Acknowledge completion of the streamed RPC turn.
    },
    onError(message) {
      streamError = message;
    },
  });

  if (streamError) return jsonResponse({ ok: false, error: streamError }, { status: 502 });
  return jsonResponse({ ok: true, sessionId, answer });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({
        ok: true,
        example: 'rpc-chat-memory',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId] = parts;
    if (request.method === 'POST' && kind === 'chat' && sessionId) {
      return chatTurn(request, env, sessionId);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
