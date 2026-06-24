// Live proof for cli-http-ground-truth.
//
// 1. /health attests the personal-account deploy.
// 2. Read the runtime-only CLI token from /cli-token (the ground truth the
//    model cannot have invented).
// 3. Ask the agent a question that can only be answered by running the CLI.
// 4. Assert the agent's answer contains the runtime token (it used the CLI),
//    and that a durable audit row records the run_cli tool call.
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

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean; example: string }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected || health.example !== 'cli-http-ground-truth') {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ /health attests personal-account deploy');

const { token } = await body<{ token: string }>('/cli-token');
if (!token) throw new Error('no runtime CLI token returned');
console.log(`✓ runtime-only CLI ground-truth token = ${token}`);

const session = `cli-${Date.now()}`;
const chat = await body<{ answer: string }>(`/chat/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: 'Run the CLI command `status` and tell me the exact build id it reports.',
  }),
});
console.log(`  agent answer: ${chat.answer.slice(0, 160)}`);

if (!chat.answer.includes(token)) {
  throw new Error(
    `agent answer did not contain the CLI ground-truth token ${token} — it may have hallucinated instead of using the CLI: ${chat.answer}`,
  );
}
console.log('✓ agent answer carries the CLI stdout token (used the CLI as ground truth, not a guess)');

const { audit } = await body<{ audit: Array<{ command: string; exitCode: number; stdout: string }> }>(
  `/audit/${session}`,
);
const statusRuns = audit.filter((r) => r.command.trim().startsWith('status'));
if (statusRuns.length < 1) {
  throw new Error(`expected a durable run_cli audit row for "status"; got ${JSON.stringify(audit)}`);
}
if (!statusRuns.some((r) => r.stdout.includes(token))) {
  throw new Error(`audit row stdout did not carry the runtime token ${token}: ${JSON.stringify(statusRuns)}`);
}
console.log(`✓ durable audit recorded ${statusRuns.length} run_cli call(s); stdout carried the ground-truth token`);
console.log('✅ cli-http-ground-truth E2E passed: CLI stdout was the agent ground truth');
