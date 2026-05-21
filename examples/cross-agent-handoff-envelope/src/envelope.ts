// Typed, deterministic cross-agent handoff envelope.
//
// The envelope is the only contract that crosses the boundary between Producer
// and Consumer agents. It is NOT free-form LLM prose. It is constructed in
// Worker code from a runtime fact and verified by checksum on both sides, so
// transfer is machine-readable and tamper-evident.

import { z } from 'zod';

export const HANDOFF_ENVELOPE_VERSION = 'cross-agent-handoff/v1' as const;

export const HandoffEnvelopeSchema = z.object({
  schema: z.literal(HANDOFF_ENVELOPE_VERSION),
  envelopeId: z.string().min(1),
  issuedAt: z.string().datetime(),
  producer: z.object({
    agent: z.literal('Producer'),
    sessionId: z.string().min(1),
  }),
  consumer: z.object({
    agent: z.literal('Consumer'),
    sessionId: z.string().min(1),
  }),
  payload: z.object({
    // The runtime fact that must cross the boundary intact. Treated as opaque.
    token: z.string().min(1),
    // Optional structured context the producer wants the consumer to act on.
    intent: z.string().min(1),
  }),
  // sha256 over canonical JSON of `payload` — deterministic transfer integrity.
  checksum: z.object({
    algorithm: z.literal('sha256'),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>;

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function checksumPayload(payload: HandoffEnvelope['payload']): Promise<string> {
  const data = new TextEncoder().encode(canonicalJSON(payload));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildEnvelope(input: {
  envelopeId: string;
  producerSessionId: string;
  consumerSessionId: string;
  token: string;
  intent: string;
}): Promise<HandoffEnvelope> {
  const payload = { token: input.token, intent: input.intent };
  const value = await checksumPayload(payload);
  return HandoffEnvelopeSchema.parse({
    schema: HANDOFF_ENVELOPE_VERSION,
    envelopeId: input.envelopeId,
    issuedAt: new Date().toISOString(),
    producer: { agent: 'Producer', sessionId: input.producerSessionId },
    consumer: { agent: 'Consumer', sessionId: input.consumerSessionId },
    payload,
    checksum: { algorithm: 'sha256', value },
  });
}

export async function verifyEnvelope(envelope: unknown): Promise<HandoffEnvelope> {
  const parsed = HandoffEnvelopeSchema.parse(envelope);
  const recomputed = await checksumPayload(parsed.payload);
  if (recomputed !== parsed.checksum.value) {
    throw new Error(
      `handoff envelope checksum mismatch: expected ${parsed.checksum.value}, recomputed ${recomputed}`,
    );
  }
  return parsed;
}
