/**
 * Headless multi-tab broadcast probe.
 *
 * Two AgentClient WebSocket connections attach to the same Think Durable
 * Object (same `name`). Only client A sends a `cf_agent_use_chat_request`.
 * The probe asserts that BOTH clients observe streamed
 * `cf_agent_use_chat_response` deltas — i.e. Think's `_broadcastChat` fans
 * the response out to every connected protocol client on that DO.
 *
 * This is the headless equivalent of "open the same chat in two browser
 * tabs and watch them stream the same answer". No UI.
 */
export {};

import { AgentClient } from 'agents/client';

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

const baseUrl = new URL(base);
const host = baseUrl.host;

// 1) Personal-account attestation, identical safety rail to the parent probe.
{
  const response = await fetch(`${base}/health`);
  const text = await response.text();
  if (!response.ok) throw new Error(`/health HTTP ${response.status}: ${text}`);
  const health = JSON.parse(text) as { ok: boolean; deployAccountMatchesExpected: boolean };
  if (!health.ok || !health.deployAccountMatchesExpected) {
    throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
  }
  console.log(
    '✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time',
  );
}

interface ProtocolMessage {
  type: string;
  body?: string;
  done?: boolean;
  id?: string;
  messages?: unknown[];
  name?: string;
}

interface Recorder {
  label: string;
  client: AgentClient;
  events: ProtocolMessage[];
  identityReady: Promise<void>;
  receivedResponseFor: (requestId: string) => boolean;
  responseTextFor: (requestId: string) => string;
  doneFor: (requestId: string) => boolean;
}

function makeClient(label: string, sessionName: string): Recorder {
  const events: ProtocolMessage[] = [];
  let resolveIdentity!: () => void;
  const identityReady = new Promise<void>((r) => {
    resolveIdentity = r;
  });

  const client = new AgentClient({
    agent: 'Assistant',
    name: sessionName,
    host,
    // partysocket picks wss:// automatically for a non-localhost host
  });

  client.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    let parsed: ProtocolMessage;
    try {
      parsed = JSON.parse(event.data) as ProtocolMessage;
    } catch {
      return;
    }
    events.push(parsed);
    if (parsed.type === 'cf_agent_identity') resolveIdentity();
  });

  client.addEventListener('error', (event) => {
    console.error(`[${label}] socket error`, (event as ErrorEvent).message ?? event);
  });

  function receivedResponseFor(requestId: string) {
    return events.some(
      (e) => e.type === 'cf_agent_use_chat_response' && e.id === requestId,
    );
  }

  function responseTextFor(requestId: string) {
    let out = '';
    for (const e of events) {
      if (e.type !== 'cf_agent_use_chat_response' || e.id !== requestId) continue;
      if (!e.body) continue;
      try {
        const chunk = JSON.parse(e.body) as { type?: string; delta?: string; text?: string };
        if (chunk.type === 'text-delta') out += chunk.delta ?? chunk.text ?? '';
      } catch {
        // non-JSON control frames don't contain answer text
      }
    }
    return out;
  }

  function doneFor(requestId: string) {
    return events.some(
      (e) => e.type === 'cf_agent_use_chat_response' && e.id === requestId && e.done === true,
    );
  }

  return {
    label,
    client,
    events,
    identityReady,
    receivedResponseFor,
    responseTextFor,
    doneFor,
  };
}

const sessionName = `multi-tab-${Date.now()}`;
console.log(`session: ${sessionName} @ ${host}`);

const tabA = makeClient('A', sessionName);
const tabB = makeClient('B', sessionName);

// Wait for both protocol clients to receive their identity announcement,
// proving the WebSocket upgraded and Agent onStart() finished.
await Promise.race([
  Promise.all([tabA.identityReady, tabB.identityReady]),
  new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error('timed out waiting for two protocol identities')), 30_000),
  ),
]);
console.log('✓ both clients attached to the same Think DO and received identity');

// Send exactly one chat-request from tab A.
const requestId = crypto.randomUUID();
const userMessage = {
  id: crypto.randomUUID(),
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: 'Reply in one short sentence: broadcast acknowledged.' }],
};
const chatRequest = {
  type: 'cf_agent_use_chat_request',
  id: requestId,
  init: {
    method: 'POST',
    body: JSON.stringify({ messages: [userMessage] }),
  },
};
tabA.client.send(JSON.stringify(chatRequest));
console.log(`→ tab A sent cf_agent_use_chat_request id=${requestId}`);

// Wait for BOTH tabs to see the streaming response complete.
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  if (tabA.doneFor(requestId) && tabB.doneFor(requestId)) break;
  await new Promise((r) => setTimeout(r, 250));
}

const aGot = tabA.receivedResponseFor(requestId);
const bGot = tabB.receivedResponseFor(requestId);
const aDone = tabA.doneFor(requestId);
const bDone = tabB.doneFor(requestId);
const aText = tabA.responseTextFor(requestId);
const bText = tabB.responseTextFor(requestId);

console.log(
  `tab A: received=${aGot} done=${aDone} chunks=${tabA.events.filter((e) => e.type === 'cf_agent_use_chat_response' && e.id === requestId).length} text=${JSON.stringify(aText)}`,
);
console.log(
  `tab B: received=${bGot} done=${bDone} chunks=${tabB.events.filter((e) => e.type === 'cf_agent_use_chat_response' && e.id === requestId).length} text=${JSON.stringify(bText)}`,
);

tabA.client.close();
tabB.client.close();

if (!aGot || !bGot) {
  throw new Error(
    `broadcast incomplete: tab A received=${aGot}, tab B received=${bGot} (id=${requestId})`,
  );
}
if (!aDone || !bDone) {
  throw new Error(
    `broadcast did not complete on both tabs: A done=${aDone}, B done=${bDone} (id=${requestId})`,
  );
}
if (aText.length === 0 || bText.length === 0) {
  throw new Error(`broadcast produced no text on at least one tab: A=${aText.length}, B=${bText.length}`);
}

console.log('✓ both protocol clients observed the streamed chat response for the same request id');
console.log('✓ multi-tab broadcast verified against the live Think DO');
