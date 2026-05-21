export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

const chatSession = `chat-${Date.now()}`;
const chat = (message: string) => body<{ answer: string }>(`/chat/${chatSession}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
});
await chat('Remember this exact fact: my calibration word is octarine. Reply only: stored.');
const second = await chat('What is my calibration word? Answer with that word.');
if (!second.answer.toLowerCase().includes('octarine')) throw new Error(`Think chat memory not observed: ${second.answer}`);
console.log('✓ native Think chat() persisted memory across two Worker RPC turns');

const submitSession = `submit-${Date.now()}`;
const accepted = await body<{ submission: { submissionId: string; accepted: boolean; status: string } }>(`/submit/${submitSession}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    message: 'Reply exactly: durable turn complete.', idempotencyKey: `e2e-${Date.now()}`,
  }),
});
if (!accepted.submission.accepted || !accepted.submission.submissionId) throw new Error(`submission not durably accepted: ${JSON.stringify(accepted)}`);
console.log(`✓ submitMessages() durably accepted ${accepted.submission.submissionId} (${accepted.submission.status})`);

let terminal: { status?: string } | null = null;
for (let attempt = 0; attempt < 90; attempt++) {
  const inspected = await body<{ submission: { status?: string } | null }>(`/submit/${submitSession}/inspect/${accepted.submission.submissionId}`);
  terminal = inspected.submission;
  if (terminal && ['completed', 'aborted', 'skipped', 'error'].includes(terminal.status ?? '')) break;
  await Bun.sleep(2000);
}
if (terminal?.status !== 'completed') throw new Error(`durable submission did not complete: ${JSON.stringify(terminal)}`);
console.log('✓ inspectSubmission() observed completed durable programmatic turn');
