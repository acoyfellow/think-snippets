// Live probe for examples/clientless-subagent-rpc.
//
// Asserts the three things this example exists to prove:
//   1. The child streamed: parent observed chunkCount > 0 and
//      textDeltaCount > 0 from the raw `child.chat()` callback.
//   2. The child durably wrote messages to its own DO SQLite (child
//      messageCount grew across two delegate() calls into the same
//      child session).
//   3. Two distinct child sessions are isolated: a fact taught to child A
//      is *not* recallable from child B via the same parent.
//   4. The parent assembled a non-empty answer derived from the stream.
//
// No React, no UI, no SSE — just raw RPC and JSON.
export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

type DelegateResponse = {
  ok: boolean;
  parent: { id: string };
  child: { sessionId: string; messageCount: number };
  streaming: { chunkCount: number; textDeltaCount: number };
  answer: string;
  error?: string;
};

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example?: string }>(
  '/health',
);
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'clientless-subagent-rpc') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts clientless-subagent-rpc deployed under CLOUDFLARE_PERSONAL_ACCOUNT_ID');

const stamp = Date.now();
const parentId = `parent-${stamp}`;
const childA = `child-A-${stamp}`;
const childB = `child-B-${stamp}`;
const calibrationWord = 'octarine';

function delegate(childSessionId: string, message: string) {
  return body<DelegateResponse>(`/delegate/${parentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ childSessionId, message }),
  });
}

// (1) Parent delegates to child A: store a calibration word.
const turn1 = await delegate(
  childA,
  `Remember this exact fact: my calibration word is ${calibrationWord}. Reply only: stored.`,
);
if (turn1.streaming.chunkCount === 0) {
  throw new Error(`expected streamed chunks from child, got 0: ${JSON.stringify(turn1)}`);
}
if (turn1.streaming.textDeltaCount === 0) {
  throw new Error(`expected text-delta chunks from child, got 0: ${JSON.stringify(turn1)}`);
}
if (turn1.answer.trim().length === 0) {
  throw new Error(`expected non-empty assembled answer from parent, got empty: ${JSON.stringify(turn1)}`);
}
console.log(
  `✓ parent received streamed child output ` +
    `(chunks=${turn1.streaming.chunkCount}, text-deltas=${turn1.streaming.textDeltaCount})`,
);

// (2) Parent delegates to child A again: ask for the recall. The child must
// have durably persisted turn 1, so it can recall the word.
const turn2 = await delegate(childA, 'What is my calibration word? Answer with that one word.');
if (!turn2.answer.toLowerCase().includes(calibrationWord)) {
  throw new Error(
    `child A did not recall calibration word across raw-RPC turns: ${JSON.stringify(turn2)}`,
  );
}
if (turn2.child.messageCount <= turn1.child.messageCount) {
  throw new Error(
    `expected child A messageCount to grow across turns ` +
      `(turn1=${turn1.child.messageCount}, turn2=${turn2.child.messageCount})`,
  );
}
console.log(
  `✓ child A persisted ${turn2.child.messageCount} messages in its own DO SQLite across raw-RPC turns`,
);

// (3) Parent now delegates to a *different* child session B. B has never been
// told the calibration word. If B answers with the word, isolation is broken.
const turnB = await delegate(
  childB,
  'What is my calibration word? Answer with that one word, or literally "unknown" if you do not know.',
);
if (turnB.answer.toLowerCase().includes(calibrationWord)) {
  throw new Error(
    `child isolation violated: child B leaked child A's fact: ${JSON.stringify(turnB)}`,
  );
}
console.log('✓ child B has isolated state — child A\'s fact did not leak across DO sessions');

// (4) Direct sanity check: hit the child DOs through their own GET surface and
// confirm A has more durable messages than the freshly-touched B.
const inspectA = await body<{ messageCount: number }>(`/child/${childA}`);
const inspectB = await body<{ messageCount: number }>(`/child/${childB}`);
if (inspectA.messageCount < 4) {
  throw new Error(`expected child A to have >= 4 durable messages, got ${inspectA.messageCount}`);
}
if (inspectB.messageCount === inspectA.messageCount) {
  throw new Error(
    `expected child A and B durable message counts to differ ` +
      `(A=${inspectA.messageCount}, B=${inspectB.messageCount})`,
  );
}
console.log(
  `✓ direct DO inspection confirms isolation (childA.messageCount=${inspectA.messageCount}, childB.messageCount=${inspectB.messageCount})`,
);

console.log('✓ clientless-subagent-rpc: parent agent → child Think raw RPC contract verified');
