import { Think } from '@cloudflare/think';
import type { SubmitMessagesResult } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

export interface Env {
  AI: Ai;
  Assistant: DurableObjectNamespace<Assistant>;
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

export class Assistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are the tiny verifiable Project Think assistant.',
      'Answer plainly and preserve user-provided facts so later turns can recall them.',
    ].join(' ');
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function assistant(env: Env, sessionId: string) {
  // Bare DO RPC does not await PartyServer/Agents onStart().
  // getAgentByName() synchronizes initialization before user RPC methods like Think.chat().
  return getAgentByName(env.Assistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function chat(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Hello from Think.';
  const stub = (await assistant(env, sessionId)) as unknown as {
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
        // Think may emit non-JSON control frames. They do not contain answer text.
      }
    },
    onDone() {
      // The RPC callback contract expects completion acknowledgement.
    },
    onError(message) {
      error = message;
    },
  });

  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, answer });
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

async function submit(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Reply exactly: accepted.';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
  const stub = (await assistant(env, sessionId)) as unknown as {
    submitMessages: (
      messages: ReturnType<typeof userMessage>[],
      options?: { idempotencyKey?: string; metadata?: Record<string, unknown> },
    ) => Promise<SubmitMessagesResult>;
  };

  const submission = await stub.submitMessages([userMessage(message)], {
    idempotencyKey,
    metadata: { example: 'durable-submit' },
  });
  return json({ ok: true, sessionId, submission });
}

async function inspect(env: Env, sessionId: string, submissionId: string) {
  const stub = (await assistant(env, sessionId)) as unknown as {
    inspectSubmission: (id: string) => Promise<unknown>;
  };
  return json({ ok: true, sessionId, submission: await stub.inspectSubmission(submissionId) });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'think-snippets',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, action, id] = path;
    if (request.method === 'POST' && kind === 'chat' && sessionId) return chat(request, env, sessionId);
    if (request.method === 'POST' && kind === 'submit' && sessionId) return submit(request, env, sessionId);
    if (request.method === 'GET' && kind === 'submit' && sessionId && action === 'inspect' && id) return inspect(env, sessionId, id);

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
