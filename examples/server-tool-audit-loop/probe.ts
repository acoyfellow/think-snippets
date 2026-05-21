export {};

// Live probe for server-tool-audit-loop.
//
// Proves three things end-to-end against a real Workers.dev deployment:
//   1. The Worker attests it deployed onto CLOUDFLARE_PERSONAL_ACCOUNT_ID.
//   2. The model called the custom server-side tool revealCalibrationCode —
//      a row exists in the durable tool_audit SQLite table for this session.
//   3. The assistant's text response actually used the tool's deterministic,
//      runtime-only output (the 12-hex-char code appears verbatim in the answer).

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

interface AuditRow {
  id: number;
  ts: number;
  toolName: string;
  input: string;
  output: string;
  success: number;
  durationMs: number;
}

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const health = await body<{ ok: boolean; deployAccountMatchesExpected: boolean }>('/health');
if (!health.ok || !health.deployAccountMatchesExpected) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
console.log('✓ live Worker asserts deploy account matched CLOUDFLARE_PERSONAL_ACCOUNT_ID at deploy time');

const session = `audit-${Date.now()}`;
const label = `calib-${Math.random().toString(36).slice(2, 8)}`;

const chatResp = await body<{ answer: string }>(`/chat/${session}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: `Please reveal the calibration code for label "${label}". Use the tool. Reply in the exact format code=<code>.`,
  }),
});

const audit = await body<{ rows: AuditRow[] }>(`/audit/${session}`);
const toolRows = audit.rows.filter((row) => row.toolName === 'revealCalibrationCode' && row.success === 1);
if (toolRows.length === 0) {
  throw new Error(`expected durable audit row for revealCalibrationCode, got: ${JSON.stringify(audit.rows)}`);
}
console.log(`✓ durable audit table recorded ${toolRows.length} successful tool execution(s)`);

const recorded = toolRows[toolRows.length - 1];
const recordedInput = JSON.parse(recorded.input) as { label?: string };
if (recordedInput.label !== label) {
  throw new Error(`audit input label mismatch: expected ${label}, got ${recorded.input}`);
}
console.log('✓ audit row input.label matches the probe-provided label (model wired the request through)');

const recordedOutput = JSON.parse(recorded.output) as { code?: string; label?: string; source?: string };
const code = recordedOutput.code;
if (!code || !/^[0-9a-f]{12}$/.test(code)) {
  throw new Error(`audit row output.code is not a 12-hex code: ${recorded.output}`);
}
if (recordedOutput.source !== 'runtime-derived') {
  throw new Error(`audit row output.source not runtime-derived: ${recorded.output}`);
}
console.log(`✓ audit row output carries the runtime-derived calibration code ${code}`);

if (!chatResp.answer.includes(code)) {
  throw new Error(
    `assistant answer did not contain the tool's runtime code ${code}. answer was: ${JSON.stringify(chatResp.answer)}`,
  );
}
console.log('✓ assistant response embedded the tool\'s runtime-derived code verbatim (tool output reached the model)');
