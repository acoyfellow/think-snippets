import { Think } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { Effect } from 'effect';

// Isolated example: a Think DO whose custom tool body is an Effect program.
//
// The tool registration is pure Think (via the `ai` SDK's `tool()` factory,
// matching every other Think example in this repo). The tool's `execute`
// function runs an `Effect.gen(...)` block and resolves with
// `Effect.runPromise`. That single `runPromise` is the only seam between the
// two systems.
//
// What this proves: Think tools can have Effect-shaped bodies — typed errors,
// timeouts, retries, structured concurrency — without changing how Think
// registers or invokes them.

export interface Env {
  AI: Ai;
  Greeter: DurableObjectNamespace<Greeter>;
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

// The Effect program — pure, no Think, no `ai` SDK, no env.
// Inputs are plain values; output is a string.
const greetEffect = (name: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep('50 millis'); // demonstrate Effect runs the body
    if (!name.trim()) {
      return yield* Effect.fail(new Error('name is required'));
    }
    return `Hello, ${name.trim()}! Welcome to Think + Effect.`;
  }).pipe(Effect.timeout('5 seconds'));

export class Greeter extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a greeting assistant.',
      'When the user gives you a name to greet, you MUST call the `greet` tool with that name.',
      'Reply with exactly the tool result and nothing else.',
    ].join(' ');
  }

  getTools() {
    return {
      greet: tool({
        description: 'Greet a person by name. Returns a friendly greeting string.',
        inputSchema: z.object({
          name: z
            .string()
            .min(1)
            .max(120)
            .describe('The name of the person to greet.'),
        }),
        // The seam between Think (the host) and Effect (the body).
        // `execute` is just an async function; we run the Effect program
        // inside it and resolve with `Effect.runPromise`.
        execute: async ({ name }) => {
          const greeting = await Effect.runPromise(greetEffect(name));
          return { greeting };
        },
      }),
    };
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function greeterStub(env: Env, sessionId: string) {
  return getAgentByName(env.Greeter, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function readBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

async function chatTurn(request: Request, env: Env, sessionId: string) {
  const body = await readBody(request);
  const message =
    typeof body.message === 'string' ? body.message : 'Greet Alice.';
  const stub = (await greeterStub(env, sessionId)) as unknown as {
    chat: (userMessage: string, callback: StreamCallback) => Promise<void>;
  };

  let answer = '';
  let streamError: string | undefined;

  await stub.chat(message, {
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        // Non-JSON control frames carry no answer text.
      }
    },
    onDone() {
      // ack
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
        example: 'effect-hello',
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
