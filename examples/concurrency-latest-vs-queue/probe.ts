/**
 * Live probe for the concurrency-latest-vs-queue example.
 *
 * For each variant (queue, latest) the probe:
 *   1. POST /clear/:variant/:session — start from a clean slate.
 *   2. Open one WebSocket to /agents/:agent/:session.
 *   3. Fire THREE `cf_agent_use_chat_request` frames back-to-back with distinct
 *      request IDs and labels (A, B, C), with a server-side per-turn delay
 *      so all three land while the first is still in flight.
 *   4. Capture each request's terminal `cf_agent_use_chat_response` frame.
 *   5. GET /history/:variant/:session — read persisted UIMessages.
 *
 * Why THREE submits, not two? `SubmitConcurrencyController.decide()` (see
 * node_modules/agents/dist/chat/index.js#L336) gives the FIRST submit
 * `submitSequence: null` because `queuedTurnsInCurrentEpoch === 0` at its
 * admission, so it can never be superseded. With only two submits, the
 * second's submitSequence is 1 and `_latestOverlappingSubmitSequence` is also
 * 1, so `isSuperseded(1)` returns false. The differentiator appears at three:
 *
 *   - Turn A admitted; running.
 *   - Turn B admitted while A is running: submitSequence=1, _latestOverlap=1.
 *   - Turn C admitted while A is running and B is queued: submitSequence=2,
 *     _latestOverlap=2.
 *   - A completes. B's task body checks isSuperseded(1) against _latestOverlap=2
 *     → true → `_completeSkippedRequest` sends `{body: "", done: true}`.
 *   - C runs normally.
 *
 * Deterministic differentiator (NOT a timing race):
 *   - All three user messages are persisted either way (Think persists incoming
 *     user messages before the enqueue/supersede gate, see
 *     Think._handleChatRequest at think.js#L1959).
 *   - QUEUE: all three submits get non-empty terminal bodies and three
 *     assistant messages persist.
 *   - LATEST: exactly one (the middle, B) terminal frame is the empty
 *     superseded frame; only TWO assistant messages persist (A and C).
 *
 * These invariants are checkable from receipt frames and history regardless
 * of the actual model output text. The per-turn `slow` tool delay enforces
 * overlap deterministically — we are not depending on timing flakiness.
 */

export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

type WireResponse = {
  type: 'cf_agent_use_chat_response';
  id: string;
  body: string;
  done?: boolean;
};

type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string; toolName?: string }>;
};

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// Tool delay is large enough that all three submits are admitted before the
// first turn finishes. Conservative: with workers-ai latency + 5s tool sleep,
// the first turn easily lasts >2s after the third submit is sent.
// Each queued turn blocks the next (queue mode is serial), so total wall time
// is ~3 x (delay + model reasoning latency). Keep the delay small but still a
// real overlap window; the WS timeout below carries the rest.
const TURN_DELAY_MS = 1500;
const INTER_SEND_GAP_MS = 200;

const LABELS = ['A', 'B', 'C'] as const;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const attempts = 8; // /clear and /history are idempotent; retry the fresh-route flap on all methods
  let last = '';
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    const response = await fetch(`${base}${path}`, init);
    lastStatus = response.status;
    last = await response.text();
    if (response.ok) return JSON.parse(last) as T;
    const transient =
      (response.status === 404 && last.includes('There is nothing here yet')) ||
      (response.status === 500 && last.includes('Worker threw exception')) ||
      (!response.ok && /error code: 10\d\d/.test(last));
    if (!transient) break;
    await Bun.sleep(1500);
  }
  throw new Error(`${path} HTTP ${lastStatus}: ${last}`);
}

const health = await http<{ ok: boolean; deployAccountMatchesExpected: boolean }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

function userMessage(label: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: `LABEL=${label}` }],
  };
}

type RequestReceipt = {
  requestId: string;
  contentChunks: number;
  streamedTextPreview: string;
  done: boolean;
  errorFrame: boolean;
};

async function driveTurn(variant: 'queue' | 'latest', sessionId: string): Promise<{
  receipts: RequestReceipt[];
  history: UIMessage[];
  requestOrder: string[];
}> {
  await http(`/clear/${variant}/${sessionId}`, { method: 'POST' });

  const agentName = variant === 'queue' ? 'queue-assistant' : 'latest-assistant';
  const wsBase = base!.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/agents/${agentName}/${sessionId}`;

  const ws = new WebSocket(wsUrl);
  const receipts = new Map<string, RequestReceipt>();
  const orderedRequestIds: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = (event: Event) => reject(new Error(`WS error before open: ${String(event)}`));
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });

  const ensure = (id: string): RequestReceipt => {
    let r = receipts.get(id);
    if (!r) {
      r = { requestId: id, contentChunks: 0, streamedTextPreview: '', done: false, errorFrame: false };
      receipts.set(id, r);
    }
    return r;
  };

  const allDone = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for terminal frames; got ${[...receipts.values()].filter((r) => r.done).length}/${LABELS.length}`)),
      // 3 serial queue turns x (5s injected delay + cold model latency) can
      // exceed 2min on a cold isolate; give it headroom.
      180000,
    );
    ws.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { type?: string }).type !== 'cf_agent_use_chat_response'
      ) {
        return;
      }
      const frame = parsed as WireResponse & { error?: boolean };
      if (!orderedRequestIds.includes(frame.id)) return; // ignore replay/other ids
      const r = ensure(frame.id);
      if (frame.done) {
        r.done = true;
        if (frame.error) r.errorFrame = true;
      } else {
        // Streaming content chunk. Body is a JSON-stringified UIMessageChunk.
        r.contentChunks += 1;
        if (r.streamedTextPreview.length < 80) {
          try {
            const chunk = JSON.parse(frame.body) as { type: string; delta?: string; text?: string };
            if (chunk.type === 'text-delta') {
              r.streamedTextPreview = (r.streamedTextPreview + (chunk.delta ?? chunk.text ?? '')).slice(0, 80);
            }
          } catch {
            // non-JSON control frame
          }
        }
      }
      const finished = [...receipts.values()].filter((r2) => r2.done).length;
      if (finished >= LABELS.length && orderedRequestIds.every((id) => receipts.get(id)?.done)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WS errored mid-stream'));
    });
  });

  function sendChatRequest(label: string) {
    const id = crypto.randomUUID();
    orderedRequestIds.push(id);
    ws.send(
      JSON.stringify({
        type: 'cf_agent_use_chat_request',
        id,
        init: {
          method: 'POST',
          body: JSON.stringify({
            messages: [userMessage(label)],
            trigger: 'submit-message',
            // Custom body is forwarded to beforeTurn(ctx).body — our slow tool reads this.
            turnDelayMs: TURN_DELAY_MS,
          }),
        },
      }),
    );
  }

  for (const label of LABELS) {
    sendChatRequest(label);
    if (label !== LABELS[LABELS.length - 1]) await new Promise((r) => setTimeout(r, INTER_SEND_GAP_MS));
  }

  await allDone;

  ws.close();
  await new Promise((r) => setTimeout(r, 750));

  const { messages } = await http<{ messages: UIMessage[] }>(`/history/${variant}/${sessionId}`);
  const receiptsList = orderedRequestIds.map((id) => receipts.get(id)!);
  return { receipts: receiptsList, history: messages, requestOrder: orderedRequestIds };
}

function countAssistant(history: UIMessage[]) {
  return history.filter((m) => m.role === 'assistant').length;
}
function countUser(history: UIMessage[]) {
  return history.filter((m) => m.role === 'user').length;
}
function summarize(label: string, r: { receipts: RequestReceipt[]; history: UIMessage[]; requestOrder: string[] }) {
  return {
    variant: label,
    submittedRequestIds: r.requestOrder,
    receipts: r.receipts.map((rec) => ({
      requestId: rec.requestId,
      contentChunks: rec.contentChunks,
      streamedTextPreview: rec.streamedTextPreview,
      done: rec.done,
      errorFrame: rec.errorFrame,
    })),
    userCount: countUser(r.history),
    assistantCount: countAssistant(r.history),
  };
}

const queueResult = await driveTurn('queue', `queue-${RUN_ID}`);
console.log('queue receipts:', JSON.stringify(summarize('queue', queueResult), null, 2));

const latestResult = await driveTurn('latest', `latest-${RUN_ID}`);
console.log('latest receipts:', JSON.stringify(summarize('latest', latestResult), null, 2));

// --- Assertions: deterministic, observable, receipt-based ---

// Both variants persist all three user messages (Think persists incoming user
// messages prior to the enqueue/supersede check; see Think._handleChatRequest).
if (countUser(queueResult.history) !== LABELS.length) {
  throw new Error(`queue: expected ${LABELS.length} persisted user messages, got ${countUser(queueResult.history)}`);
}
if (countUser(latestResult.history) !== LABELS.length) {
  throw new Error(`latest: expected ${LABELS.length} persisted user messages, got ${countUser(latestResult.history)}`);
}

// QUEUE: every submit produces streaming content chunks before its done frame
// AND persists an assistant message.
if (countAssistant(queueResult.history) !== LABELS.length) {
  throw new Error(
    `queue: expected ${LABELS.length} assistant messages, got ${countAssistant(queueResult.history)}`,
  );
}
for (const rec of queueResult.receipts) {
  if (rec.contentChunks === 0) {
    throw new Error(
      `queue: receipt ${rec.requestId} unexpectedly had 0 content chunks before done (looks superseded)`,
    );
  }
}
console.log('✓ queue: all 3 submits streamed content and persisted 3 assistant messages');

// LATEST: exactly one of the three receipts must have 0 content chunks
// (the superseded one — `_completeSkippedRequest` sends only the done frame).
const supersededReceipts = latestResult.receipts.filter((r) => r.contentChunks === 0);
if (supersededReceipts.length !== 1) {
  throw new Error(
    `latest: expected exactly 1 superseded receipt (0 content chunks), got ${supersededReceipts.length}; ` +
      `receipts=${JSON.stringify(latestResult.receipts)}`,
  );
}

// LATEST: only 2 assistant messages persist (the surviving submits); the
// superseded one's assistant message is never persisted.
if (countAssistant(latestResult.history) !== LABELS.length - 1) {
  throw new Error(
    `latest: expected ${LABELS.length - 1} assistant messages, got ${countAssistant(latestResult.history)}`,
  );
}

// LATEST: the superseded receipt must be the MIDDLE request (B). The first is
// admitted with submitSequence=null (cannot be superseded) and the last has
// the highest sequence (cannot be superseded by anything later in this run).
const supersededId = supersededReceipts[0].requestId;
const supersededIndex = latestResult.requestOrder.indexOf(supersededId);
if (supersededIndex !== 1) {
  throw new Error(
    `latest: expected the MIDDLE submit (index 1) to be superseded, got index ${supersededIndex}; ` +
      `requestOrder=${JSON.stringify(latestResult.requestOrder)} supersededId=${supersededId}`,
  );
}
console.log('✓ latest: middle submit (B) was superseded (0 content chunks); A and C streamed and persisted assistant messages');

console.log('✅ concurrency-latest-vs-queue probe passed');
