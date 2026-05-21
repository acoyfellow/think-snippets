import { Think } from '@cloudflare/think';
import { routeAgentRequest } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

export interface Env {
  AI: Ai;
  Assistant: DurableObjectNamespace<Assistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

// Isolated Think DO for the multi-tab broadcast example. Intentionally lives
// alongside this example only — does not share class identity with src/worker.ts
// so the alchemy resource is independent.
export class Assistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are a tiny verification assistant for a multi-tab broadcast probe.',
      'Reply in one short sentence so the streaming deltas are easy to observe.',
    ].join(' ');
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'multi-tab-broadcast-protocol',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    // Hand WebSocket upgrades and `/agents/...` HTTP to the Agents router.
    // This is the path the protocol AgentClient connects to:
    //   wss://<host>/agents/assistant/<sessionId>
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
