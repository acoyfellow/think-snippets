// Live E2E probe for examples/workspace-write-read-proof.
//
// Verification model (avoids prompt-leak-only proof):
//   1. Send a chat instruction that names a workspace path and a content
//      marker the user/probe controls. The system prompt forces the model to
//      call the `write` tool with those exact values.
//   2. Use a SEPARATE Worker endpoint (/inspect/.../file) that reads the DO's
//      durable Workspace directly via DO RPC — independent of the model's
//      streamed text — and assert the bytes are present.
//   3. Also assert the file appears in /inspect/.../list, confirming it is a
//      first-class filesystem entry, not an in-memory side effect.

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

// Personal-account attestation, identical contract to the top-level probe.
const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example: string }>(
  '/health',
);
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'workspace-write-read-proof') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

const session = `ws-${Date.now()}`;
const targetPath = '/notes/proof.txt';
// Marker the probe owns. Includes a fresh nonce so even if the model had
// somehow seen this path before, the bytes are unique to this run.
const nonce = crypto.randomUUID();
const marker = `WORKSPACE_PROOF_${nonce}`;
const content = `calibration: octarine\nrun: ${nonce}\nmarker: ${marker}\n`;

// Step 1: ask the assistant to write the file using the workspace `write` tool.
const instruction = [
  'Call the write tool with exactly these arguments and no others:',
  `path: ${targetPath}`,
  'content (between the BEGIN/END markers, exclusive, preserving newlines):',
  '---BEGIN---',
  content.replace(/\n+$/, ''),
  '---END---',
  'After the tool call succeeds, reply only with: wrote ' + targetPath,
].join('\n');

const chatResponse = await body<{
  ok: boolean;
  answer: string;
  toolCalls: { name: string; args?: { path?: string; content?: string } }[];
}>(`/chat/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: instruction }),
});
if (!chatResponse.ok) throw new Error(`chat turn failed: ${JSON.stringify(chatResponse)}`);
console.log(`✓ chat turn completed (toolCalls observed: ${chatResponse.toolCalls.map((c) => c.name).join(', ') || 'none-in-stream'})`);

// Step 2: independent inspection — read the DO's durable workspace directly.
const file = await body<{ file: { exists: boolean; content: string | null; size: number | null; path: string } }>(
  `/inspect/${session}/file?path=${encodeURIComponent(targetPath)}`,
);
if (!file.file.exists) {
  throw new Error(`workspace write not durable: ${targetPath} missing. Chat answer was: ${chatResponse.answer}`);
}
if (typeof file.file.content !== 'string' || !file.file.content.includes(marker)) {
  throw new Error(
    `workspace content missing nonce marker. Got ${file.file.size ?? 0} bytes at ${file.file.path}: ${JSON.stringify(
      file.file.content,
    )}`,
  );
}
console.log(
  `✓ DO-backed Workspace.readFile(${targetPath}) returned ${file.file.size} bytes containing run-unique marker ${marker}`,
);

// Step 3: independent directory listing — proves it's a real filesystem entry.
const list = await body<{ list: { dir: string; entries: { name: string; isDirectory: boolean }[] } }>(
  `/inspect/${session}/list?dir=${encodeURIComponent('/notes')}`,
);
const found = list.list.entries.find((e) => e.name === 'proof.txt' && !e.isDirectory);
if (!found) {
  throw new Error(`expected proof.txt in /notes; got ${JSON.stringify(list.list.entries)}`);
}
console.log('✓ DO-backed Workspace.readDir(/notes) shows proof.txt as a file entry');

console.log('✅ workspace-write-read-proof verified: Think workspace `write` tool wrote durable DO-backed bytes');
