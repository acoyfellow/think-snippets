import { Think } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

// This example is intentionally isolated from src/worker.ts so the
// initialization-seam claim can be deployed, probed, and torn down on its own.
//
// What we are proving live:
//   - A native Think DO that extends Agents/PartyServer and runs an async
//     onStart() lifecycle hook BEFORE its user-defined RPC methods should run.
//   - Routing through getAgentByName() awaits that onStart() before returning
//     a stub, so a custom RPC observing onStart() side-effects is guaranteed
//     to see them.
//
// What we are recording but NOT triggering at E2E time:
//   - env.Assistant.get(env.Assistant.idFromName(...)).whenInitialized() is
//     the "bare DO RPC" path. It does not await Agents onStart(). Calling
//     user RPC through it during cold start can observe pre-onStart state or
//     throw because PartyServer wiring has not finished. We document that
//     hazard in /inspect/bare-rpc-hazard so the E2E remains stable on the
//     real, safe path and does not depend on reproducing a production crash.

export interface Env {
  AI: Ai;
  RpcSafetyAssistant: DurableObjectNamespace<RpcSafetyAssistant>;
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

// The marker is intentionally set inside onStart() — not in the constructor —
// because that is exactly the lifecycle window getAgentByName() awaits and
// bare DO RPC does not. Probing this marker through the safe seam is the
// initialization-safety attestation.
const INIT_MARKER = 'rpc-init-safety:onStart-completed';

export class RpcSafetyAssistant extends Think<Env> {
  // PartyServer/Agents lifecycle. Agents awaits this during getAgentByName().
  async onStart() {
    // Persist a durable marker so a later RPC turn can attest that onStart()
    // actually completed before the RPC ran, not just that the constructor
    // finished.
    this.ctx.storage.put(INIT_MARKER, {
      completedAtMs: Date.now(),
      via: 'onStart',
    });
  }

  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return 'You are the rpc-init-safety probe assistant. Answer plainly.';
  }

  // Custom RPC method — visible to getAgentByName() stubs. Returns the
  // onStart() attestation record so the probe can prove the seam.
  async whenInitialized(): Promise<{ initialized: boolean; marker: unknown }> {
    const marker = await this.ctx.storage.get(INIT_MARKER);
    return { initialized: marker !== undefined, marker: marker ?? null };
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function safeStub(env: Env, sessionId: string) {
  // The safe seam. Agents awaits onStart() before this resolves.
  return getAgentByName(env.RpcSafetyAssistant, sessionId, {
    routingRetry: { maxAttempts: 3 },
  });
}

async function getBody(request: Request) {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

// /safe/:sessionId/init  — proves onStart() ran before this RPC observed state.
async function safeInit(env: Env, sessionId: string) {
  const stub = (await safeStub(env, sessionId)) as unknown as {
    whenInitialized: () => Promise<{ initialized: boolean; marker: unknown }>;
  };
  const result = await stub.whenInitialized();
  return json({ ok: true, sessionId, seam: 'getAgentByName', ...result });
}

// /safe/:sessionId/chat  — proves Think.chat() works through the safe seam.
async function safeChat(request: Request, env: Env, sessionId: string) {
  const body = await getBody(request);
  const message = typeof body.message === 'string' ? body.message : 'Reply exactly: ready.';
  const stub = (await safeStub(env, sessionId)) as unknown as {
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
        // Think emits non-JSON control frames; they do not carry answer text.
      }
    },
    onDone() {
      // RPC callback contract requires completion ack.
    },
    onError(message) {
      error = message;
    },
  });

  if (error) return json({ ok: false, error }, { status: 502 });
  return json({ ok: true, sessionId, seam: 'getAgentByName', answer });
}

// /inspect/bare-rpc-hazard — static, deterministic explanation of the unsafe
// path. We deliberately do not execute the bare RPC here because:
//   1. The exact failure mode (silent stale state vs. thrown error) varies
//      across @cloudflare/think and agents versions during cold start.
//   2. An E2E that depends on reproducing a production crash to pass is
//      itself a flaky test of the wrong thing.
// Instead we publish the seam contract the safe probe asserts against.
function inspectBareRpcHazard() {
  return json({
    ok: true,
    seam: 'documented-hazard',
    unsafePattern: 'env.RpcSafetyAssistant.get(env.RpcSafetyAssistant.idFromName(id)).whenInitialized()',
    safePattern: "getAgentByName(env.RpcSafetyAssistant, id).then(stub => stub.whenInitialized())",
    why: [
      'Think extends Agents (PartyServer). Agents runs an async onStart() lifecycle hook on cold start.',
      'A bare DurableObjectStub returned by ns.get(id) does not await that hook before user RPC methods run.',
      'getAgentByName() routes through the Agents runtime, which awaits onStart() before resolving the stub.',
      'Therefore: anything that depends on onStart() side-effects (state set, providers wired, indexes hydrated) must go through getAgentByName().',
    ],
    attestation: {
      marker: INIT_MARKER,
      observedThrough: '/safe/:sessionId/init',
      expectedShape: { initialized: true, marker: { completedAtMs: 'number', via: 'onStart' } },
    },
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'think-snippets',
        example: 'rpc-init-safety',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    if (url.pathname === '/inspect/bare-rpc-hazard') {
      return inspectBareRpcHazard();
    }

    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [kind, sessionId, action] = path;

    if (request.method === 'GET' && kind === 'safe' && sessionId && action === 'init') {
      return safeInit(env, sessionId);
    }
    if (request.method === 'POST' && kind === 'safe' && sessionId && action === 'chat') {
      return safeChat(request, env, sessionId);
    }

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
