// Live probe for examples/rpc-chat-memory.
//
// Asserts the streamed Think.chat() RPC bridge persists a session fact across
// two independent HTTP requests pointing at the same Durable Object session.
export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  let last = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${base}${path}`, init);
    lastStatus = response.status;
    last = await response.text();
    if (response.ok) return JSON.parse(last) as T;
    const transient = (response.status === 404 && last.includes('There is nothing here yet')) ||
      (response.status === 500 && last.includes('Worker threw exception'));
    if (!transient) break;
    await Bun.sleep(1500);
  }
  throw new Error(`${path} HTTP ${lastStatus}: ${last}`);
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example?: string }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'rpc-chat-memory') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts rpc-chat-memory deployed under CLOUDFLARE_PERSONAL_ACCOUNT_ID');

const sessionId = `rpc-chat-memory-${Date.now()}`;
const calibrationWord = 'octarine';

const chat = (message: string) => body<{ answer: string }>(`/chat/${sessionId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message }),
});

await chat(`Remember this exact fact: my calibration word is ${calibrationWord}. Reply only: stored.`);
const second = await chat('What is my calibration word? Answer with that one word.');

if (!second.answer.toLowerCase().includes(calibrationWord)) {
  throw new Error(`Think.chat() RPC did not persist session fact across requests: ${second.answer}`);
}
console.log(`✓ streamed Think.chat() RPC persisted "${calibrationWord}" across two independent HTTP requests`);
