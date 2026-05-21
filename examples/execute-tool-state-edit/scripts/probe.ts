// Live probe for the execute-tool-state-edit example.
//
// 1. Asserts the deployed Worker attests its account matched
//    CLOUDFLARE_PERSONAL_ACCOUNT_ID and that the LOADER binding is bound.
// 2. POSTs guest JavaScript to /execute/:session. The guest code:
//      - writes a unique marker file via `state.writeFile`,
//      - reads it back via `state.readFile` and returns its content,
//      - tries to `fetch()` an external URL and reports the thrown error
//        message, so the probe can prove the sandbox is network-isolated.
// 3. Reads the same path back through the Think workspace via
//    GET /state/:session/<path>. The parent DO sees the bytes the
//    sandbox wrote → end-to-end proof that sandboxed JavaScript mutated
//    Think workspace state.

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

const health = await body<{
  ok: boolean;
  loaderBound: boolean;
  deployAccountMatchesExpected: boolean;
}>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
if (!health.loaderBound) {
  throw new Error('worker_loaders binding LOADER is not present on the deployed Worker');
}
console.log('✓ live Worker asserts personal-account deploy + LOADER binding present');

const session = `exec-${Date.now()}`;
const marker = `snippet-${crypto.randomUUID()}`;
const path = `/sandbox/${marker}.txt`;

// Guest code runs inside DynamicWorkerExecutor. `state.*` is provided by
// createWorkspaceStateBackend(this.workspace). The block returned from
// the IIFE becomes `CodeOutput.result`.
const code = `
  await state.writeFile(${JSON.stringify(path)}, ${JSON.stringify(marker)});
  const readBack = await state.readFile(${JSON.stringify(path)});
  let networkError = null;
  try {
    await fetch("https://example.com");
    networkError = "no-error-network-was-not-blocked";
  } catch (err) {
    networkError = String(err && err.message || err);
  }
  return { wrote: ${JSON.stringify(path)}, readBack, networkError };
`;

const exec = await body<{
  output: { result: { wrote: string; readBack: string; networkError: string }; logs?: string[] };
}>(`/execute/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code }),
});

const result = exec.output?.result;
if (!result || typeof result !== 'object') {
  throw new Error(`sandbox did not return a structured result: ${JSON.stringify(exec)}`);
}
if (result.readBack !== marker) {
  throw new Error(
    `sandbox state round-trip failed: wrote ${marker}, read ${JSON.stringify(result.readBack)}`,
  );
}
console.log(`✓ sandboxed JS round-tripped ${marker} via state.writeFile / state.readFile`);

if (!/network|fetch|outbound|disallow|not allowed|blocked|forbid/i.test(result.networkError)) {
  throw new Error(
    `sandbox network isolation not observed; fetch() reported: ${JSON.stringify(result.networkError)}`,
  );
}
console.log(`✓ sandbox outbound network blocked by default (${result.networkError})`);

// Independent read-back through the parent DO proves the sandbox mutated
// the SAME Think workspace, not a private isolate-local store.
const verify = await body<{ content: string | null }>(`/state/${session}${path}`);
if (verify.content !== marker) {
  throw new Error(
    `parent DO did not observe sandbox write: workspace readFile returned ${JSON.stringify(
      verify.content,
    )}`,
  );
}
console.log('✓ parent Think DO observed the sandbox-written workspace file directly');
