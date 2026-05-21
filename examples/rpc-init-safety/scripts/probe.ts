export {};

// Live probe for rpc-init-safety. Verifies:
//   1. The Worker attests it deployed to CLOUDFLARE_PERSONAL_ACCOUNT_ID.
//   2. Routing through getAgentByName() exposes onStart() side-effects to a
//      custom RPC method — i.e. the safe initialization seam works end to end.
//   3. The hazard-explanation endpoint is published and self-consistent.
//      We assert its shape rather than triggering the unsafe path so the
//      E2E does not depend on reproducing a production cold-start crash.

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  let last = '';
  let lastStatus = 0;
  const attempts = init?.method && init.method !== 'GET' ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(`${base}${path}`, init);
    lastStatus = response.status;
    last = await response.text();
    if (response.ok) return JSON.parse(last) as T;
    if (response.status !== 404 || !last.includes('There is nothing here yet')) break;
    await Bun.sleep(1500);
  }
  throw new Error(`${path} HTTP ${lastStatus}: ${last}`);
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example?: string }>(
  '/health',
);
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'rpc-init-safety') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ rpc-init-safety Worker attests personal-account deploy');

// (2) The safe seam attestation. getAgentByName() must await onStart() before
// returning the stub, so whenInitialized() must observe the marker that
// onStart() wrote to durable storage.
const session = `init-${Date.now()}`;
const safe = await body<{
  ok: boolean;
  seam: string;
  initialized: boolean;
  marker: { completedAtMs?: number; via?: string } | null;
}>(`/safe/${session}/init`);
if (safe.seam !== 'getAgentByName') {
  throw new Error(`unexpected seam label: ${JSON.stringify(safe)}`);
}
if (!safe.initialized || !safe.marker || safe.marker.via !== 'onStart') {
  throw new Error(`safe seam did not observe onStart() side-effects: ${JSON.stringify(safe)}`);
}
console.log('✓ getAgentByName() awaited onStart() before whenInitialized() RPC observed state');

// (3) Hazard documentation is published.
const hazard = await body<{
  ok: boolean;
  seam: string;
  unsafePattern: string;
  safePattern: string;
  attestation: { marker: string; observedThrough: string };
}>('/inspect/bare-rpc-hazard');
if (hazard.seam !== 'documented-hazard') {
  throw new Error(`hazard endpoint did not return documented-hazard seam: ${JSON.stringify(hazard)}`);
}
if (!hazard.unsafePattern.includes('idFromName')) {
  throw new Error(`hazard endpoint did not name the unsafe bare-DO RPC pattern: ${hazard.unsafePattern}`);
}
if (!hazard.safePattern.includes('getAgentByName')) {
  throw new Error(`hazard endpoint did not name the safe seam: ${hazard.safePattern}`);
}
if (hazard.attestation.observedThrough !== '/safe/:sessionId/init') {
  throw new Error(
    `hazard attestation pointer disagrees with probe path: ${JSON.stringify(hazard.attestation)}`,
  );
}
console.log('✓ /inspect/bare-rpc-hazard publishes safe vs unsafe seam contract');

// (4) Light end-to-end: the safe seam still serves a real Think.chat() turn.
// We only assert ok+answer-nonempty here; chat memory is already proved in
// examples/chat-rpc and we deliberately do not duplicate that claim.
const chat = await body<{ ok: boolean; answer: string }>(`/safe/${session}/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'Reply exactly: ready.' }),
});
if (!chat.ok || typeof chat.answer !== 'string' || chat.answer.length === 0) {
  throw new Error(`safe seam Think.chat() did not return text: ${JSON.stringify(chat)}`);
}
console.log('✓ Think.chat() over the safe seam returned text');

console.log('✅ rpc-init-safety probe passed');
