/**
 * stream-resume-contract — isolated Worker.
 *
 * Exposes a native `Think` Durable Object behind the Agents websocket
 * routing prefix so the live probe can drive the real
 * `cf_agent_use_chat_request` → `cf_agent_stream_resume_request` →
 * `cf_agent_stream_resume_ack` recovery handshake against the actual
 * `@cloudflare/think` implementation.
 *
 * This file is intentionally self-contained and shares nothing with
 * `src/worker.ts` so the contract can be deployed and torn down on its
 * own without touching other examples.
 */

import { Think } from '@cloudflare/think';
import { routeAgentRequest } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';

export interface Env {
  AI: Ai;
  StreamResumeAssistant: DurableObjectNamespace<StreamResumeAssistant>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

export class StreamResumeAssistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }

  getSystemPrompt() {
    return [
      'You are the stream-resume contract probe assistant.',
      'When asked to list words, output each requested word on its own line, exactly,',
      'in the requested order, with no extra commentary.',
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        project: 'think-snippets',
        example: 'stream-resume-contract',
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    // routeAgentRequest serves both /agents/<kebab>/<name> websocket
    // upgrades (the cf_agent_chat_* protocol) and HTTP routes that the
    // Agent forwards through `onRequest` such as `/get-messages`.
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
