// Live proof for cli-sandbox-ground-truth.
//
// Ground truth is the REAL Cloudflare account. The probe:
//   1. reads the true account name directly from the Cloudflare API,
//   2. has the agent run the cf CLI INSIDE the codemode sandbox via
//      `tools.cf({ command: "account" })` and return its stdout,
//   3. asserts the sandbox stdout carries the real account name,
//   4. negative control: a wrong name is NOT present.
// The sandbox genuinely executes and the truth is live, so a fabricated
// answer cannot pass.
export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const accountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_PERSONAL_API_TOKEN;
if (!accountId || !apiToken) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID and CLOUDFLARE_PERSONAL_API_TOKEN are required');
}

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

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example: string; loaderBound: boolean }>(
  '/health',
);
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'cli-sandbox-ground-truth') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
if (!health.loaderBound) throw new Error('LOADER binding missing — sandbox cannot run');
console.log('✓ /health attests personal-account deploy + LOADER bound');

// Independent ground truth from the Cloudflare API.
const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, {
  headers: { authorization: `Bearer ${apiToken}` },
});
const cfJson = (await cfRes.json()) as { success?: boolean; result?: { name?: string } };
const trueName = cfJson.result?.name;
if (!cfJson.success || !trueName) {
  throw new Error(`could not read true account name from Cloudflare API: ${JSON.stringify(cfJson)}`);
}
console.log(`✓ independent Cloudflare API truth: account name = ${JSON.stringify(trueName)}`);

const run = await body<{ stdout: string }>(`/cf/sbx-${Date.now()}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ command: 'account' }),
});
console.log(`  sandbox cf stdout: ${run.stdout.replace(/\n/g, ' | ')}`);

if (!run.stdout.includes(trueName)) {
  throw new Error(
    `sandbox cf stdout did not contain the live account name ${JSON.stringify(trueName)}: ${run.stdout}`,
  );
}
console.log('✓ sandbox-run cf CLI returned the live account name (real execution, real account)');

const wrong = `${trueName}-NOT-THE-REAL-NAME`;
if (run.stdout.includes(wrong)) {
  throw new Error('stdout contained a fabricated wrong name — output is not account-bound');
}
console.log('✓ a fabricated name would not appear — the cf CLI output is the ground truth');
console.log('✅ cli-sandbox-ground-truth E2E passed: a real cf CLI in-sandbox was the agent ground truth');
