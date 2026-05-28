// Live probe for examples/effect-hello.
//
// Asserts a Think DO whose custom tool body is an Effect program actually
// invokes the tool and returns the Effect-computed greeting in the assistant's
// final answer.
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
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'effect-hello') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts effect-hello deployed under CLOUDFLARE_PERSONAL_ACCOUNT_ID');

const sessionId = `effect-hello-${Date.now()}`;
const targetName = 'Octarine';

const chat = (message: string) => body<{ answer: string }>(`/chat/${sessionId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message }),
});

// Ask the model to greet a unique name; the Effect-backed tool produces a
// deterministic string ("Hello, <name>! Welcome to Think + Effect.") that the
// model is instructed to return verbatim.
const turn = await chat(`Please greet ${targetName} using the greet tool.`);

if (!turn.answer.toLowerCase().includes(targetName.toLowerCase())) {
  throw new Error(`Effect-backed Think tool did not produce a greeting containing the target name: ${turn.answer}`);
}
if (!turn.answer.toLowerCase().includes('think + effect')) {
  throw new Error(`Tool output did not propagate to the assistant answer: ${turn.answer}`);
}
console.log(`✓ Think tool ran an Effect program and the greeting reached the assistant answer: "${turn.answer}"`);
