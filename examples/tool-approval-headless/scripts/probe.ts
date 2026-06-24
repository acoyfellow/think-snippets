// Live E2E probe for the headless tool-approval flow.
//
// All assertions are headless: no UI, no human button. Each scenario submits a
// durable Think message, polls until the submission terminates, and inspects
// the durable audit table the Worker keeps in DO SQLite.
//
// Scenarios proved:
//   A. denial         -> server-enforced block, audit.decision=denied, no side effect
//   B. no_approval    -> ticket never created, audit.decision=denied (unknown_ticket), no side effect
//   C. approved_once  -> approve then transfer once: audit.decision=executed, counter+1.
//                        replay same ticket: audit.decision=denied (already_used), counter unchanged.

export {};

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

interface AuditRow {
  id: number;
  ts: number;
  ticket: string | null;
  toolName: string;
  decision: 'executed' | 'denied';
  reason: string;
  inputJson: string;
}
interface SideEffect {
  counter: number;
  lastTicket: string | null;
  lastAt: number | null;
}
interface SubmissionState {
  submissionId: string;
  accepted: boolean;
  status: string;
}

async function rpc<T>(path: string, init?: RequestInit): Promise<T> {
  let last = '';
  let lastStatus = 0;
  // The platform can transiently surface either a workers.dev HTML 404 or a
  // cold first-hit 1101 immediately after deployment. The route is known-good
  // once retried; approval creation is idempotent by ticket, so these POSTs are
  // safe to retry in the proof harness too.
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${base}${path}`, init);
    lastStatus = response.status;
    last = await response.text();
    if (response.ok) return JSON.parse(last) as T;
    const transient = (response.status === 404 && last.includes('There is nothing here yet')) ||
      (response.status === 500 && last.includes('Worker threw exception')) ||
      (!response.ok && /error code: 10\d\d/.test(last));
    if (!transient) break;
    await Bun.sleep(1500);
  }
  throw new Error(`${path} HTTP ${lastStatus}: ${last}`);
}

async function health() {
  const r = await rpc<{ ok: boolean; deployAccountMatchesExpected: boolean }>(`/health`);
  if (!r.ok || !r.deployAccountMatchesExpected) {
    throw new Error(`personal deployment attestation failed: ${JSON.stringify(r)}`);
  }
  console.log('✓ live Worker asserts deploy account == CLOUDFLARE_PERSONAL_ACCOUNT_ID');
}

async function createTicket(session: string, ticket: string) {
  return rpc<{ approval: { ticket: string; status: string } }>(
    `/approval/${session}/create/${ticket}`,
    { method: 'POST' },
  );
}
async function decide(session: string, ticket: string, kind: 'approve' | 'deny') {
  return rpc<{ approval: { ticket: string; status: string } }>(
    `/approval/${session}/${kind}/${ticket}`,
    { method: 'POST' },
  );
}

async function submit(session: string, ticket: string, idempotencyKey: string) {
  return rpc<{ submission: SubmissionState }>(`/transfer/${session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvalTicket: ticket, amount: 25, to: 'savings', idempotencyKey }),
  });
}

async function waitTerminal(session: string, submissionId: string) {
  for (let i = 0; i < 90; i++) {
    const r = await rpc<{ submission: { status?: string } | null }>(
      `/transfer/${session}/inspect/${submissionId}`,
    );
    const s = r.submission?.status;
    if (s && ['completed', 'aborted', 'skipped', 'error'].includes(s)) return s;
    await Bun.sleep(2000);
  }
  throw new Error(`submission ${submissionId} did not terminate`);
}

async function getAudit(session: string) {
  return rpc<{ audit: AuditRow[]; sideEffect: SideEffect }>(`/audit/${session}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

await health();

// ----- Scenario A: explicit denial -----
const sessA = `denied-${Date.now()}`;
const ticketA = `ticket-A-${crypto.randomUUID()}`;
await createTicket(sessA, ticketA);
await decide(sessA, ticketA, 'deny');
const subA = await submit(sessA, ticketA, `e2e-A-${Date.now()}`);
const statusA = await waitTerminal(sessA, subA.submission.submissionId);
assert(statusA === 'completed', `denial submission terminal status was ${statusA}`);
const stateA = await getAudit(sessA);
assert(stateA.audit.length >= 1, 'no audit row recorded for denial');
const lastA = stateA.audit[stateA.audit.length - 1]!;
assert(lastA.decision === 'denied', `expected denied, got ${lastA.decision} (${lastA.reason})`);
assert(lastA.reason === 'denied', `expected reason=denied, got ${lastA.reason}`);
assert(stateA.sideEffect.counter === 0, `denied path executed side effect: ${stateA.sideEffect.counter}`);
console.log(`✓ A. denial: beforeToolCall blocked (reason=${lastA.reason}); counter=${stateA.sideEffect.counter}`);

// ----- Scenario B: no approval (unknown ticket) -----
const sessB = `unknown-${Date.now()}`;
const ticketB = `ticket-B-${crypto.randomUUID()}`; // never created
const subB = await submit(sessB, ticketB, `e2e-B-${Date.now()}`);
const statusB = await waitTerminal(sessB, subB.submission.submissionId);
assert(statusB === 'completed', `unknown-ticket submission terminal status was ${statusB}`);
const stateB = await getAudit(sessB);
assert(stateB.audit.length >= 1, 'no audit row recorded for unknown ticket');
const lastB = stateB.audit[stateB.audit.length - 1]!;
assert(lastB.decision === 'denied', `expected denied, got ${lastB.decision} (${lastB.reason})`);
assert(
  lastB.reason === 'unknown_ticket',
  `expected reason=unknown_ticket, got ${lastB.reason}`,
);
assert(stateB.sideEffect.counter === 0, `no-approval path executed side effect: ${stateB.sideEffect.counter}`);
console.log(`✓ B. no_approval: beforeToolCall blocked (reason=${lastB.reason}); counter=${stateB.sideEffect.counter}`);

// ----- Scenario C: approved -> executes exactly once; replay blocked -----
const sessC = `approved-${Date.now()}`;
const ticketC = `ticket-C-${crypto.randomUUID()}`;
await createTicket(sessC, ticketC);
await decide(sessC, ticketC, 'approve');
const subC1 = await submit(sessC, ticketC, `e2e-C1-${Date.now()}`);
const statusC1 = await waitTerminal(sessC, subC1.submission.submissionId);
assert(statusC1 === 'completed', `approved submission terminal status was ${statusC1}`);
const stateC1 = await getAudit(sessC);
const executedRows = stateC1.audit.filter((r) => r.decision === 'executed' && r.ticket === ticketC);
assert(
  executedRows.length === 1,
  `expected exactly one executed audit row for approved ticket; got ${executedRows.length} (${JSON.stringify(stateC1.audit)})`,
);
assert(
  stateC1.sideEffect.counter === 1,
  `approved path should increment counter to 1; got ${stateC1.sideEffect.counter}`,
);
assert(
  stateC1.sideEffect.lastTicket === ticketC,
  `side effect should record last ticket ${ticketC}; got ${stateC1.sideEffect.lastTicket}`,
);
console.log(`✓ C1. approved: executed exactly once; counter=${stateC1.sideEffect.counter}`);

// Replay the same ticket — should be blocked as already_used.
const subC2 = await submit(sessC, ticketC, `e2e-C2-${Date.now()}`);
const statusC2 = await waitTerminal(sessC, subC2.submission.submissionId);
assert(statusC2 === 'completed', `replay submission terminal status was ${statusC2}`);
const stateC2 = await getAudit(sessC);
const lastC2 = stateC2.audit[stateC2.audit.length - 1]!;
assert(
  lastC2.decision === 'denied' && lastC2.reason === 'already_used',
  `expected already_used denial on replay, got ${lastC2.decision}/${lastC2.reason}`,
);
assert(
  stateC2.sideEffect.counter === 1,
  `replay must not increment counter; got ${stateC2.sideEffect.counter}`,
);
console.log(`✓ C2. replay blocked (reason=${lastC2.reason}); counter still ${stateC2.sideEffect.counter}`);

console.log('✅ tool-approval-headless: all three branches proved against live Think Worker');
