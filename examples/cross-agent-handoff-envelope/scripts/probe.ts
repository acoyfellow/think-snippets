// Live probe for cross-agent-handoff-envelope.
//
// Asserts:
//   1. /health attests deploy account == CLOUDFLARE_PERSONAL_ACCOUNT_ID.
//   2. The producer endpoint returns a typed envelope matching the schema and
//      whose payload.token equals the runtime-injected token (deterministic
//      transfer, not LLM prose).
//   3. The envelope's checksum recomputes correctly worker-side AND prober-side
//      over canonical-JSON(payload).
//   4. The consumer endpoint, given only envelopeId, durably accepts a Think
//      submission whose metadata.receivedToken equals the original token.
//   5. inspectSubmission on the Consumer DO reaches `completed`, proving real
//      durable evidence on a second, distinct agent.
//   6. The envelope record in HandoffStore is annotated with the consumer's
//      submissionId — machine-readable cross-agent linkage.
export {};

import { HandoffEnvelopeSchema, verifyEnvelope } from '../src/envelope';

const base = process.env.WORKER_URL;
if (!base) throw new Error('WORKER_URL is required');
const expected = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID;
if (!expected) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required');

async function body<T>(path: string, init?: RequestInit): Promise<T> {
  let last = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${base}${path}`, init);
    lastStatus = response.status;
    last = await response.text();
    if (response.ok) return JSON.parse(last) as T;
    const transient = (response.status === 404 && last.includes('There is nothing here yet')) ||
      (response.status === 500 && last.includes('Worker threw exception'));
    if (!transient) break;
    await Bun.sleep(1500);
  }
  throw new Error(`${path} HTTP ${lastStatus}: ${last}`);
}

interface SubmissionShape {
  submissionId: string;
  accepted: boolean;
  status: string;
}

const health = await body<{
  ok: boolean;
  example: string;
  envelopeSchema: string;
  deployAccountMatchesExpected: boolean;
}>('/health');
if (
  !health.ok ||
  !health.deployAccountMatchesExpected ||
  health.example !== 'cross-agent-handoff-envelope'
) {
  throw new Error(`personal deployment attestation failed: ${JSON.stringify(health)}`);
}
if (health.envelopeSchema !== 'cross-agent-handoff/v1') {
  throw new Error(`envelope schema mismatch: ${health.envelopeSchema}`);
}
console.log('✓ /health attests personal account + envelope schema v1');

const runId = Date.now();
const producerSessionId = `producer-${runId}`;
const consumerSessionId = `consumer-${runId}`;
const token = `token-${crypto.randomUUID()}`;
const intent = 'forward this calibration token to the consumer agent';

const produced = await body<{
  envelopeId: string;
  envelope: unknown;
  storedAt: string;
  producer: { sessionId: string; submission: SubmissionShape };
}>('/handoff/produce', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ producerSessionId, consumerSessionId, token, intent }),
});

const envelope = HandoffEnvelopeSchema.parse(produced.envelope);
await verifyEnvelope(envelope); // prober-side checksum recomputation
if (envelope.payload.token !== token) {
  throw new Error(`envelope token drift: expected ${token}, got ${envelope.payload.token}`);
}
if (envelope.payload.intent !== intent) {
  throw new Error(`envelope intent drift: expected ${intent}, got ${envelope.payload.intent}`);
}
if (envelope.producer.sessionId !== producerSessionId || envelope.consumer.sessionId !== consumerSessionId) {
  throw new Error(`envelope session ids drifted: ${JSON.stringify(envelope)}`);
}
if (!produced.producer.submission.accepted || !produced.producer.submission.submissionId) {
  throw new Error(`producer submission not durably accepted: ${JSON.stringify(produced.producer.submission)}`);
}
console.log(
  `✓ producer emitted typed envelope ${envelope.envelopeId} carrying runtime token deterministically`,
);
console.log(
  `✓ envelope sha256 ${envelope.checksum.value} verifies on both worker and prober`,
);
console.log(
  `✓ producer Think submission ${produced.producer.submission.submissionId} durably accepted (${produced.producer.submission.status})`,
);

// Consumer reads from durable store only; producer chat history is NOT consulted.
const consumed = await body<{
  envelopeId: string;
  envelope: unknown;
  consumer: { sessionId: string; submission: SubmissionShape };
  record: { envelope: unknown; consumerSubmissionId?: string; consumerStatus?: string };
}>('/handoff/consume', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ envelopeId: envelope.envelopeId }),
});

const consumedEnvelope = HandoffEnvelopeSchema.parse(consumed.envelope);
if (consumedEnvelope.checksum.value !== envelope.checksum.value) {
  throw new Error('consumer-side envelope checksum drifted from producer-side');
}
if (consumedEnvelope.payload.token !== token) {
  throw new Error(
    `consumer received wrong token: expected ${token}, got ${consumedEnvelope.payload.token}`,
  );
}
if (!consumed.consumer.submission.accepted || !consumed.consumer.submission.submissionId) {
  throw new Error(`consumer submission not durably accepted: ${JSON.stringify(consumed.consumer.submission)}`);
}
if (consumed.record.consumerSubmissionId !== consumed.consumer.submission.submissionId) {
  throw new Error('handoff store annotation did not record consumer submissionId');
}
console.log(
  `✓ consumer agent (distinct DO ${consumerSessionId}) received the same token via durable envelope`,
);
console.log(
  `✓ HandoffStore record annotated with consumerSubmissionId ${consumed.record.consumerSubmissionId} — cross-agent link is machine-readable`,
);

// Poll consumer submission to reach a terminal status — durable evidence.
let terminal: { status?: string; metadata?: Record<string, unknown> } | null = null;
for (let attempt = 0; attempt < 90; attempt++) {
  const inspected = await body<{
    submission: { status?: string; metadata?: Record<string, unknown> } | null;
  }>(
    `/handoff/consumer/${encodeURIComponent(consumerSessionId)}/inspect/${encodeURIComponent(
      consumed.consumer.submission.submissionId,
    )}`,
  );
  terminal = inspected.submission;
  if (terminal && ['completed', 'aborted', 'skipped', 'error'].includes(terminal.status ?? '')) {
    break;
  }
  await Bun.sleep(2000);
}
if (terminal?.status !== 'completed') {
  throw new Error(`consumer durable submission did not complete: ${JSON.stringify(terminal)}`);
}
const metaToken =
  terminal.metadata && typeof terminal.metadata.receivedToken === 'string'
    ? (terminal.metadata.receivedToken as string)
    : undefined;
if (metaToken !== token) {
  throw new Error(
    `consumer submission metadata.receivedToken (${metaToken}) does not equal runtime token (${token})`,
  );
}
console.log(
  '✓ consumer inspectSubmission() reached completed with metadata.receivedToken == runtime token',
);

console.log(
  '✓ cross-agent handoff envelope verified: typed, deterministic, durably evidenced on both agents',
);
