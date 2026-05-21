export {};

// Live probe for the workspace-search-proof example.
//
// Proves end-to-end:
//   1. Personal-account attestation at /health (deploy guard wired up).
//   2. Seeding many workspace files via DO RPC (one carries a unique fact).
//   3. Asking Think a question whose answer can only be found by searching
//      and reading workspace files.
//   4. After the chat turn, the DO's durable `tool_log` table proves that
//      the model invoked a search-class tool (list / find / grep) and at
//      least one `read` — not lucky-guess answering.

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

interface ToolLogEntry {
  seq: number;
  ts: number;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  durationMs: number;
}

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

// --- 1. Personal-account attestation ---------------------------------------
const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ /health attests deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID');

// --- 2. Seed workspace ------------------------------------------------------
const session = `ws-search-${Date.now()}`;
const uniqueFact = `octarine-${crypto.randomUUID().slice(0, 8)}`;
const factFile = '/projects/discworld/colors.md';

const files = [
  { path: '/notes/groceries.md', content: '# groceries\n- bread\n- milk\n- coffee\n' },
  { path: '/notes/recipes.md', content: '# recipes\n## omelette\nbeat eggs, season, fold.\n' },
  { path: '/projects/discworld/wizards.md', content: '# wizards\nUnseen University faculty.\n' },
  {
    path: factFile,
    content: `# colors\n\nThe eighth color, visible only to wizards and cats, has the calibration tag: ${uniqueFact}.\nNo other file in this workspace references this tag.\n`,
  },
  { path: '/projects/discworld/geography.md', content: '# geography\nThe Disc rides on four elephants.\n' },
  { path: '/notes/todo.txt', content: 'todo:\n- fix typo in colors.md\n- email Rincewind\n' },
];

await body<{ ok: boolean; written: string[] }>('/reset/' + session, { method: 'POST' });

const seeded = await body<{ ok: boolean; written: string[] }>(`/seed/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ files }),
});
if (!seeded.ok || seeded.written.length !== files.length) {
  throw new Error(`seed failed: ${JSON.stringify(seeded)}`);
}
console.log(`✓ seeded ${seeded.written.length} workspace files; unique fact hidden in ${factFile}`);

// Snapshot the tool log right after seeding so we only assert against tool
// calls that happened during the chat turn (seeding goes through the
// `seedFiles` RPC, not the AI SDK, so it does NOT touch tool_log — but
// being defensive about the baseline keeps the assertion robust to any
// future internal Think bookkeeping calls).
const preChatLog = await body<{ log: ToolLogEntry[] }>(`/tools/${session}`);
const baseSeq = preChatLog.log.length ? preChatLog.log[preChatLog.log.length - 1]!.seq : 0;

// --- 3. Ask the question ----------------------------------------------------
const question =
  'What is the calibration tag for the eighth color? Search the workspace using your tools and answer with only the tag value.';
const chat = await body<{ ok: boolean; answer: string }>(`/chat/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: question }),
});
if (!chat.ok) throw new Error(`chat failed: ${JSON.stringify(chat)}`);
console.log(`  model answer: ${truncate(chat.answer, 200)}`);

// --- 4. Assert the durable evidence -----------------------------------------
const postLog = await body<{ log: ToolLogEntry[] }>(`/tools/${session}?afterSeq=${baseSeq}`);
const calls = postLog.log;
console.log(`  ${calls.length} tool calls recorded during the chat turn:`);
for (const call of calls) {
  console.log(`    seq=${call.seq} tool=${call.toolName} success=${call.success} durMs=${call.durationMs}`);
}

const searchTools = new Set(['list', 'find', 'grep']);
const sawSearch = calls.some((entry) => searchTools.has(entry.toolName) && entry.success);
const reads = calls.filter((entry) => entry.toolName === 'read' && entry.success);
const sawRead = reads.length > 0;
const readHitFactFile = reads.some((entry) => {
  const input = entry.input as { path?: string } | null;
  return Boolean(input && typeof input.path === 'string' && input.path === factFile);
});

const answerHasFact = chat.answer.includes(uniqueFact);

if (!sawSearch) throw new Error('expected at least one successful list/find/grep tool call — none recorded');
if (!sawRead) throw new Error('expected at least one successful read tool call — none recorded');
if (!readHitFactFile) {
  throw new Error(
    `expected a read of ${factFile}; recorded reads were: ${JSON.stringify(reads.map((r) => (r.input as { path?: string })?.path))}`,
  );
}
if (!answerHasFact) {
  throw new Error(
    `model answer did not contain the unique fact tag '${uniqueFact}'. answer=${JSON.stringify(chat.answer)}`,
  );
}

console.log(`✓ search tool fired (list/find/grep)`);
console.log(`✓ read tool fired on ${factFile}`);
console.log(`✓ model answer contained unique fact '${uniqueFact}'`);
console.log('✅ workspace-search-proof live E2E passed');

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
