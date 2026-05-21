export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

interface HealthResponse {
  ok: boolean;
  deployAccountMatchesExpected: boolean;
}
interface TriggerResponse {
  ok: boolean;
  sessionId: string;
  scheduleId: string;
  runsInMs: number;
}
interface HistoryMessagePart {
  type: string;
  text?: string;
}
interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: HistoryMessagePart[];
}
interface HistoryResponse {
  ok: boolean;
  count: number;
  messages: HistoryMessage[];
}

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

// 1. Attest personal-account deploy.
const health = await body<HealthResponse>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

// 2. Trigger a scheduled synthetic turn. The Worker enqueues an Agent
// `schedule()` row with a 1s delay — deterministic, not a real cron.
const sessionId = `scheduled-${Date.now()}`;
const calibration = `octarine-${Date.now()}`;
const prompt = `Remember this exact calibration word: ${calibration}. Reply with exactly that word.`;

const triggered = await body<TriggerResponse>(`/trigger/${sessionId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt }),
});
if (!triggered.ok || !triggered.scheduleId) {
  throw new Error(`schedule was not enqueued: ${JSON.stringify(triggered)}`);
}
console.log(`✓ schedule() enqueued ${triggered.scheduleId} (fires in ~${triggered.runsInMs}ms)`);

// 3. Poll persisted history. Before the alarm fires, history is empty; after
//    the alarm fires, `saveMessages()` injects the synthetic user turn and
//    runs the model — both messages end up persisted in DO SQLite.
function lastAssistantText(messages: HistoryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (text.length > 0) return text;
  }
  return null;
}

let assistantText: string | null = null;
let lastCount = 0;
for (let attempt = 0; attempt < 90; attempt++) {
  const h = await body<HistoryResponse>(`/history/${sessionId}`);
  lastCount = h.count;
  assistantText = lastAssistantText(h.messages);
  // We need both the injected user message AND the assistant reply persisted.
  const hasUser = h.messages.some(
    (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === prompt),
  );
  if (hasUser && assistantText) break;
  await Bun.sleep(2000);
}
if (lastCount === 0) {
  throw new Error('scheduled alarm never injected the synthetic user message into history');
}
if (!assistantText) {
  throw new Error(`scheduled turn never produced an assistant reply (count=${lastCount})`);
}
console.log(`✓ scheduled alarm injected synthetic user turn and persisted ${lastCount} messages`);

if (!assistantText.toLowerCase().includes(calibration.toLowerCase())) {
  throw new Error(`assistant reply did not contain calibration word "${calibration}": ${assistantText}`);
}
console.log('✓ assistant reply for the synthetic turn echoed the calibration word');
console.log('✅ scheduled-synthetic-turn example passed');
