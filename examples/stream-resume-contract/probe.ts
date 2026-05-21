/**
 * Live stream-resume contract probe.
 *
 * Drives the actual @cloudflare/think websocket protocol with no mock
 * transport. The flow proves that:
 *
 *   1. A turn started via `cf_agent_use_chat_request` begins streaming
 *      `cf_agent_use_chat_response` chunks back over the websocket.
 *   2. Closing that websocket mid-turn does NOT destroy the in-flight
 *      stream — Think buffers chunks in its ResumableStream (DO SQLite).
 *   3. A second websocket connection that sends
 *      `cf_agent_stream_resume_ack` with the original request id is
 *      replayed every buffered chunk, terminated by `done: true`.
 *   4. The recovered text-deltas reconstruct an assistant answer whose
 *      content matches the words that were asked for.
 *   5. After resume, GET /agents/.../get-messages reports the assistant
 *      message was persisted with the same recovered content.
 *
 * Refuses to continue if /health does not attest that the deploy
 * account equals CLOUDFLARE_PERSONAL_ACCOUNT_ID.
 */

export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expectedAccount = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expectedAccount) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

const httpBase = base.replace(/\/$/, '');
const wsBase = httpBase.replace(/^http/, 'ws');

// Words the model is asked to print, one per line, in order. We will
// look for these tokens in the recovered text-deltas. They are
// uncommon enough that prompt leakage / system text won't trigger a
// false positive.
const REQUESTED_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

interface ChatProtocolFrame {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface CollectedFrames {
  chunkBodies: string[];
  doneFrames: ChatProtocolFrame[];
  resumingFrames: ChatProtocolFrame[];
  resumeNoneFrames: ChatProtocolFrame[];
}

function newCollected(): CollectedFrames {
  return {
    chunkBodies: [],
    doneFrames: [],
    resumingFrames: [],
    resumeNoneFrames: [],
  };
}

function decodeText(collected: CollectedFrames) {
  let answer = '';
  for (const raw of collected.chunkBodies) {
    try {
      const chunk = JSON.parse(raw) as UIMessageChunk;
      if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
    } catch {
      // Non-JSON control chunks (e.g. start/finish frames) carry no text.
    }
  }
  return answer;
}

function openSocket(sessionId: string): Promise<WebSocket> {
  // Path matches routeAgentRequest("agents") prefix + kebab-case of the
  // StreamResumeAssistant binding (`stream-resume-assistant`).
  const url = `${wsBase}/agents/stream-resume-assistant/${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve(ws);
    };
    const onError = (event: Event) => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(new Error(`WS open failed: ${String((event as ErrorEvent).message ?? 'unknown')}`));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

interface CollectorOptions {
  /** Resolve once at least this many text-delta chunks have been observed. */
  untilTextDeltaCount?: number;
  /** Resolve once a `done: true` frame is observed for the given requestId. */
  untilDoneFor?: string;
  /** Hard timeout before rejecting (ms). */
  timeoutMs: number;
}

function collectFrames(
  ws: WebSocket,
  collected: CollectedFrames,
  options: CollectorOptions,
): Promise<'done' | 'enough-deltas'> {
  return new Promise((resolve, reject) => {
    let textDeltaCount = 0;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`collectFrames timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: ChatProtocolFrame;
      try {
        frame = JSON.parse(event.data) as ChatProtocolFrame;
      } catch {
        return;
      }

      if (frame.type === 'cf_agent_stream_resuming') {
        collected.resumingFrames.push(frame);
        return;
      }
      if (frame.type === 'cf_agent_stream_resume_none') {
        collected.resumeNoneFrames.push(frame);
        return;
      }
      if (frame.type !== 'cf_agent_use_chat_response') return;

      // Skip the empty terminator frame from the body accumulator.
      if (typeof frame.body === 'string' && frame.body.length > 0) {
        collected.chunkBodies.push(frame.body);
        try {
          const inner = JSON.parse(frame.body) as UIMessageChunk;
          if (inner.type === 'text-delta') textDeltaCount += 1;
        } catch {
          // Non-JSON chunk bodies are non-text control frames.
        }
      }

      if (frame.done) {
        collected.doneFrames.push(frame);
        if (options.untilDoneFor && frame.id === options.untilDoneFor) {
          cleanup();
          resolve('done');
          return;
        }
      }

      if (
        options.untilTextDeltaCount !== undefined &&
        textDeltaCount >= options.untilTextDeltaCount
      ) {
        cleanup();
        resolve('enough-deltas');
      }
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`WS closed before condition met (code=${event.code} reason=${event.reason})`));
    };
    const onError = () => {
      cleanup();
      reject(new Error('WS error before condition met'));
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  });
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    const onClose = () => {
      ws.removeEventListener('close', onClose);
      resolve();
    };
    ws.addEventListener('close', onClose);
    try {
      ws.close(4000, 'probe-disconnect');
    } catch {
      // Already closing or closed.
    }
    setTimeout(() => resolve(), 2000);
  });
}

// 1. Personal-account attestation. Refuse to drive a turn against a
//    non-personal Worker even if WORKER_URL points elsewhere.
const healthResponse = await fetch(`${httpBase}/health`);
if (!healthResponse.ok) throw new Error(`/health HTTP ${healthResponse.status}`);
const health = (await healthResponse.json()) as {
  ok: boolean;
  example?: string;
  deployAccountMatchesExpected?: boolean;
};
if (!health.ok || health.example !== 'stream-resume-contract' || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ stream-resume-contract Worker attests personal-account deploy');

const sessionId = `stream-resume-${Date.now()}`;
const requestId = crypto.randomUUID();
const userMessageId = crypto.randomUUID();
const prompt = `Print these words, one per line, in this exact order, with nothing else: ${REQUESTED_WORDS.join(' ')}.`;

// 2. Start the turn over websocket A. Collect chunks until we have
//    enough evidence the stream really started, then disconnect.
const wsA = await openSocket(sessionId);
const collectedA = newCollected();
const collectDuringA = collectFrames(wsA, collectedA, {
  untilTextDeltaCount: 1,
  timeoutMs: 120_000,
});

wsA.send(
  JSON.stringify({
    type: 'cf_agent_use_chat_request',
    id: requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: prompt }],
          },
        ],
      }),
    },
  }),
);

const aTermination = await collectDuringA;
if (collectedA.chunkBodies.length === 0) {
  throw new Error('expected at least one chunk on the original socket before disconnect');
}
console.log(
  `✓ original turn produced ${collectedA.chunkBodies.length} chunk(s) before forced disconnect (${aTermination})`,
);

await closeAndWait(wsA);

// 3. Reconnect on websocket B and drive the resume handshake.
const wsB = await openSocket(sessionId);
const collectedB = newCollected();
const collectDuringB = collectFrames(wsB, collectedB, {
  untilDoneFor: requestId,
  timeoutMs: 240_000,
});

// Ask the server whether a stream is still active. This is purely
// informational — we already know the requestId we are resuming, so
// we proceed straight to ACK whether the server replies RESUMING or
// RESUME_NONE. Both paths are valid recovery paths in Think:
//   - active stream  → replayChunks() resumes mid-flight
//   - completed stream → replayCompletedChunksByRequestId() replays
//     the persisted chunks for the same requestId.
wsB.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
wsB.send(JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: requestId }));

await collectDuringB;
await closeAndWait(wsB);

if (collectedB.chunkBodies.length === 0) {
  throw new Error('resume produced no chunks — Think did not recover the in-flight or completed stream');
}

const recovered = decodeText(collectedB);
const missing = REQUESTED_WORDS.filter((word) => !recovered.toLowerCase().includes(word));
if (missing.length > 0) {
  throw new Error(
    `resume recovered ${collectedB.chunkBodies.length} chunk(s) but answer is missing words ${JSON.stringify(missing)}; got: ${JSON.stringify(recovered)}`,
  );
}
console.log(
  `✓ resume handshake recovered ${collectedB.chunkBodies.length} chunk(s); all ${REQUESTED_WORDS.length} requested words present`,
);

if (collectedB.resumingFrames.length === 0 && collectedB.resumeNoneFrames.length === 0) {
  throw new Error('resume request produced neither cf_agent_stream_resuming nor cf_agent_stream_resume_none');
}
if (collectedB.resumingFrames.length > 0) {
  console.log(`✓ Think reported cf_agent_stream_resuming (mid-flight resume path)`);
} else {
  console.log(`✓ Think reported cf_agent_stream_resume_none + replay-by-requestId (completed-stream recovery path)`);
}

// 4. Confirm Think persisted the assistant message after recovery.
const messagesResponse = await fetch(
  `${httpBase}/agents/stream-resume-assistant/${encodeURIComponent(sessionId)}/get-messages`,
);
if (!messagesResponse.ok) {
  throw new Error(`/get-messages HTTP ${messagesResponse.status}`);
}
const persisted = (await messagesResponse.json()) as Array<{
  role: string;
  parts: Array<{ type: string; text?: string }>;
}>;
const assistantText = persisted
  .filter((m) => m.role === 'assistant')
  .flatMap((m) => m.parts ?? [])
  .filter((p) => p.type === 'text')
  .map((p) => p.text ?? '')
  .join('\n');
const persistedMissing = REQUESTED_WORDS.filter((word) => !assistantText.toLowerCase().includes(word));
if (persistedMissing.length > 0) {
  throw new Error(
    `assistant message persisted after resume is missing words ${JSON.stringify(persistedMissing)}; got: ${JSON.stringify(assistantText)}`,
  );
}
console.log('✓ persisted assistant message after resume contains every requested word');

console.log('✅ stream-resume-contract proof passed');
