// Live proof for cli-http-ground-truth.
//
// The ground truth is the REAL Cloudflare account, not a planted string.
//   1. The probe independently calls the Cloudflare API to learn the true
//      account name (using the same personal token, directly — not via the
//      agent).
//   2. It asks the agent for the account name; the agent must run the `cf`
//      CLI to answer.
//   3. It asserts the agent's answer contains the true account name AND that a
//      durable audit row shows the run_cf call returned that same name.
// A hallucinated answer fails because it is checked against live reality.
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

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example: string }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'cli-http-ground-truth') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ /health attests personal-account deploy');

// Independent ground truth: ask the Cloudflare API directly.
const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, {
  headers: { authorization: `Bearer ${apiToken}` },
});
const cfJson = (await cfRes.json()) as { success?: boolean; result?: { name?: string } };
const trueName = cfJson.result?.name;
if (!cfJson.success || !trueName) {
  throw new Error(`could not read true account name from Cloudflare API: ${JSON.stringify(cfJson)}`);
}
console.log(`✓ independent Cloudflare API truth: account name = ${JSON.stringify(trueName)}`);

const session = `cf-${Date.now()}`;
const chat = await body<{ answer: string }>(`/chat/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: 'Run the cf CLI to find this Cloudflare account name, then tell me the exact name it reports.',
  }),
});
console.log(`  agent answer: ${chat.answer.slice(0, 200)}`);

if (!chat.answer.includes(trueName)) {
  throw new Error(
    `agent answer did not contain the real account name ${JSON.stringify(trueName)} — it hallucinated instead of using the cf CLI: ${chat.answer}`,
  );
}
console.log('✓ agent answer matches live Cloudflare account name (used the cf CLI, not a guess)');

const { audit } = await body<{ audit: Array<{ command: string; stdout: string }> }>(`/audit/${session}`);
const accountRuns = audit.filter((r) => r.command.trim().startsWith('account'));
if (accountRuns.length < 1) {
  throw new Error(`expected a durable run_cf audit row for "account"; got ${JSON.stringify(audit)}`);
}
if (!accountRuns.some((r) => r.stdout.includes(trueName))) {
  throw new Error(`audit row stdout did not carry the real account name: ${JSON.stringify(accountRuns)}`);
}
console.log(`✓ durable audit recorded ${accountRuns.length} run_cf "account" call(s); stdout carried live truth`);
console.log('✅ cli-http-ground-truth E2E passed: a real cf CLI was the agent ground truth');
