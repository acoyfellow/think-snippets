// Live proof for cli-sandbox-ground-truth.
//
// 1. /health attests personal-account deploy + LOADER bound.
// 2. POST /cli/:session { arg } runs the user's CLI INSIDE the codemode
//    sandbox and returns its stdout. The stdout embeds a deterministic
//    transform of `arg` that only resolves by executing the CLI.
// 3. The probe recomputes the same transform locally and asserts the sandbox
//    stdout matches (proving real execution), and that a wrong guess does NOT
//    match (proving the value is not free-form / hallucinated).
export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  const attempts = 8;
  let last = '';
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
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

// Mirror of the in-sandbox CLI transform — used only to verify the sandbox
// actually computed it (never sent to the agent).
function expectedStdout(arg: string): string {
  let h = 5381;
  for (let i = 0; i < arg.length; i++) h = ((h << 5) + h + arg.charCodeAt(i)) >>> 0;
  return `RESULT ${arg} => ${h.toString(16)}`;
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example: string; loaderBound: boolean }>(
  '/health',
);
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'cli-sandbox-ground-truth') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
if (!health.loaderBound) throw new Error('LOADER binding missing — sandbox cannot run');
console.log('✓ /health attests personal-account deploy + LOADER bound');

const arg = `task-${Date.now()}`;
const run = await body<{ stdout: string }>(`/cli/sbx-${Date.now()}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ arg }),
});
console.log(`  sandbox CLI stdout: ${run.stdout}`);

const want = expectedStdout(arg);
if (run.stdout !== want) {
  throw new Error(`sandbox CLI stdout did not match the executed transform.\n  got:  ${run.stdout}\n  want: ${want}`);
}
console.log('✓ sandbox CLI stdout equals the executed deterministic transform (ran for real)');

// Negative control: a wrong arg must produce different stdout.
const wrong = expectedStdout(`${arg}-WRONG`);
if (run.stdout === wrong) {
  throw new Error('stdout matched a wrong-arg transform — value is not input-bound');
}
console.log('✓ a wrong guess would not match — the CLI output is the ground truth');
console.log('✅ cli-sandbox-ground-truth E2E passed: sandbox CLI stdout was the agent ground truth');
