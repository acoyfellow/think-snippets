/**
 * Probe for examples/hook-order-receipt.
 *
 * Drives one deterministic tool-invoking turn through the live OrderedAssistant
 * Worker, polls the durable submission to `completed`, fetches the hook receipt
 * and verifies the *stable* partial-order contract that the @cloudflare/think
 * public hook API actually promises:
 *
 *   - beforeTurn fires exactly once, before every other recorded hook.
 *   - onChatResponse fires exactly once, after every other recorded hook.
 *   - beforeStep count equals onStepFinish count (one per AI SDK step).
 *   - For every tool call, beforeToolCall(id) < afterToolCall(id) by sequence.
 *   - The forced `echo` tool was actually invoked at least once.
 *   - The turn reached status="completed".
 *
 * The probe deliberately does NOT assert any unstable private interleaving
 * (e.g. exact order between onStepFinish and afterToolCall across steps,
 * relative timing of beforeStep across multiple steps, or chunk-level order).
 */
export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

interface ReceiptEvent {
  seq: number;
  hook: string;
  stepNumber: number | null;
  toolCallId: string | null;
  toolName: string | null;
  detail: Record<string, unknown>;
  recordedAt: number;
}

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  let last = '';
  let lastStatus = 0;
  // A freshly uploaded workers.dev route can transiently return the platform's
  // HTML 404 while script propagation catches up, even after /health was live.
  // Poll endpoints are safe to retry; POST submissions are intentionally not.
  const attempts = init?.method && init.method !== 'GET' ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
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

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

const session = `hook-${Date.now()}`;
const phrase = `octarine-${Date.now()}`;

const accepted = await body<{
  submission: { submissionId: string; accepted: boolean; status: string };
}>(`/order/${session}/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phrase, idempotencyKey: `hook-${Date.now()}` }),
});
if (!accepted.submission.accepted || !accepted.submission.submissionId) {
  throw new Error(`submission not durably accepted: ${JSON.stringify(accepted)}`);
}
console.log(`✓ submitMessages() durably accepted ${accepted.submission.submissionId} (${accepted.submission.status})`);

let terminal: { status?: string } | null = null;
for (let attempt = 0; attempt < 120; attempt++) {
  const inspected = await body<{ submission: { status?: string } | null }>(
    `/order/${session}/inspect/${accepted.submission.submissionId}`,
  );
  terminal = inspected.submission;
  if (terminal && ['completed', 'aborted', 'skipped', 'error'].includes(terminal.status ?? '')) break;
  await Bun.sleep(2000);
}
if (terminal?.status !== 'completed') {
  throw new Error(`durable submission did not complete: ${JSON.stringify(terminal)}`);
}
console.log('✓ inspectSubmission() observed completed durable tool-invoking turn');

const receipt = await body<{ receipt: ReceiptEvent[] }>(`/order/${session}/receipt`);
const events = receipt.receipt;
if (!Array.isArray(events) || events.length === 0) {
  throw new Error(`receipt missing or empty: ${JSON.stringify(receipt)}`);
}
// Sequence numbers must be strictly increasing as returned by the DO.
for (let i = 1; i < events.length; i++) {
  if (events[i].seq <= events[i - 1].seq) {
    throw new Error(`receipt seq not strictly increasing at index ${i}: ${JSON.stringify(events)}`);
  }
}
console.log(`✓ receipt fetched: ${events.length} hook events, sequences monotonic`);

const hooks = events.map((e) => e.hook);

// --- Contract 1: beforeTurn appears exactly once and is first. -------------
const beforeTurnIndexes = events
  .map((e, idx) => (e.hook === 'beforeTurn' ? idx : -1))
  .filter((i) => i >= 0);
if (beforeTurnIndexes.length !== 1) {
  throw new Error(`beforeTurn must appear exactly once, got ${beforeTurnIndexes.length}: hooks=${JSON.stringify(hooks)}`);
}
if (beforeTurnIndexes[0] !== 0) {
  throw new Error(`beforeTurn must be the first event, got index ${beforeTurnIndexes[0]}: hooks=${JSON.stringify(hooks)}`);
}
console.log('✓ beforeTurn fired exactly once, before every other hook event');

// --- Contract 2: onChatResponse appears exactly once and is last. ----------
const onChatResponseIndexes = events
  .map((e, idx) => (e.hook === 'onChatResponse' ? idx : -1))
  .filter((i) => i >= 0);
if (onChatResponseIndexes.length !== 1) {
  throw new Error(`onChatResponse must appear exactly once, got ${onChatResponseIndexes.length}`);
}
if (onChatResponseIndexes[0] !== events.length - 1) {
  throw new Error(
    `onChatResponse must be the last event, got index ${onChatResponseIndexes[0]} of ${events.length - 1}: hooks=${JSON.stringify(hooks)}`,
  );
}
const finalStatus = events[events.length - 1].detail?.status;
if (finalStatus !== 'completed') {
  throw new Error(`onChatResponse.status expected "completed", got "${String(finalStatus)}"`);
}
console.log('✓ onChatResponse fired exactly once, after every other hook event, with status="completed"');

// --- Contract 3: beforeStep count equals onStepFinish count. ---------------
const beforeStepCount = hooks.filter((h) => h === 'beforeStep').length;
const onStepFinishCount = hooks.filter((h) => h === 'onStepFinish').length;
if (beforeStepCount === 0) {
  throw new Error('expected at least one beforeStep event');
}
if (beforeStepCount !== onStepFinishCount) {
  throw new Error(`beforeStep count (${beforeStepCount}) must equal onStepFinish count (${onStepFinishCount})`);
}
console.log(`✓ beforeStep × ${beforeStepCount} paired 1:1 with onStepFinish × ${onStepFinishCount}`);

// --- Contract 4: for each tool call, beforeToolCall.seq < afterToolCall.seq.
const beforeByCallId = new Map<string, ReceiptEvent>();
const afterByCallId = new Map<string, ReceiptEvent>();
for (const event of events) {
  if (event.hook === 'beforeToolCall' && event.toolCallId) {
    if (beforeByCallId.has(event.toolCallId)) {
      throw new Error(`duplicate beforeToolCall for toolCallId=${event.toolCallId}`);
    }
    beforeByCallId.set(event.toolCallId, event);
  } else if (event.hook === 'afterToolCall' && event.toolCallId) {
    if (afterByCallId.has(event.toolCallId)) {
      throw new Error(`duplicate afterToolCall for toolCallId=${event.toolCallId}`);
    }
    afterByCallId.set(event.toolCallId, event);
  }
}
if (beforeByCallId.size === 0) {
  throw new Error('expected at least one beforeToolCall event (echo tool was forced)');
}
for (const [callId, before] of beforeByCallId) {
  const after = afterByCallId.get(callId);
  if (!after) {
    throw new Error(`beforeToolCall for ${callId} has no matching afterToolCall`);
  }
  if (!(before.seq < after.seq)) {
    throw new Error(
      `beforeToolCall.seq (${before.seq}) must precede afterToolCall.seq (${after.seq}) for toolCallId=${callId}`,
    );
  }
  if (before.toolName !== after.toolName) {
    throw new Error(
      `tool name mismatch for ${callId}: before=${before.toolName} after=${after.toolName}`,
    );
  }
}
for (const callId of afterByCallId.keys()) {
  if (!beforeByCallId.has(callId)) {
    throw new Error(`afterToolCall for ${callId} has no matching beforeToolCall`);
  }
}
console.log(`✓ ${beforeByCallId.size} tool call(s) each had beforeToolCall < afterToolCall by sequence`);

// --- Contract 5: the forced `echo` tool was actually invoked. --------------
const echoCalls = Array.from(beforeByCallId.values()).filter((e) => e.toolName === 'echo');
if (echoCalls.length === 0) {
  throw new Error(`expected at least one beforeToolCall for tool="echo", got toolNames=${JSON.stringify(Array.from(beforeByCallId.values()).map((e) => e.toolName))}`);
}
console.log(`✓ forced echo tool was invoked ${echoCalls.length} time(s)`);

// --- Sanity: beforeToolCall happens only after at least one beforeStep. ---
// (Tool calls are nested inside a step; their `before` must follow a `beforeStep`.)
const firstBeforeStepIdx = hooks.indexOf('beforeStep');
const firstBeforeToolCallIdx = hooks.indexOf('beforeToolCall');
if (firstBeforeStepIdx === -1 || firstBeforeToolCallIdx === -1 || !(firstBeforeStepIdx < firstBeforeToolCallIdx)) {
  throw new Error(
    `first beforeStep (idx=${firstBeforeStepIdx}) must precede first beforeToolCall (idx=${firstBeforeToolCallIdx})`,
  );
}
console.log('✓ first beforeStep precedes first beforeToolCall (tool calls nest inside steps)');

console.log('✅ hook-order-receipt: stable partial-order contract holds on a live durable tool-invoking turn');
