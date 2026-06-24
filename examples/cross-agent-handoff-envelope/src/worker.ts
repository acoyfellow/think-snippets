// Cross-agent handoff envelope — isolated example.
//
// Two Think Durable Objects (Producer, Consumer) cooperate by exchanging a
// typed envelope through a third durable store (HandoffStore). The envelope
// carries a runtime token deterministically; chat is used only as durable
// audit evidence, never as the transfer channel.

import { Think } from '@cloudflare/think';
import type { SubmitMessagesResult } from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import {
  buildEnvelope,
  HandoffEnvelopeSchema,
  verifyEnvelope,
  type HandoffEnvelope,
} from './envelope';

export interface Env {
  AI: Ai;
  Producer: DurableObjectNamespace<Producer>;
  Consumer: DurableObjectNamespace<Consumer>;
  HandoffStore: DurableObjectNamespace<HandoffStore>;
  EXPECTED_ACCOUNT_ID?: string;
  DEPLOY_ACCOUNT_ID?: string;
}

interface UIMessageChunk {
  type: string;
  delta?: string;
  text?: string;
}

interface StreamCallback {
  onStart: (event: unknown) => void;
  onEvent: (json: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

abstract class HandoffThink extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })('@cf/moonshotai/kimi-k2.6');
  }
}

export class Producer extends HandoffThink {
  getSystemPrompt() {
    return [
      'You are the Producer agent in a cross-agent handoff demo.',
      'The Worker has already constructed a typed handoff envelope from the runtime token.',
      'Your only job is to acknowledge the envelope id you were told about so there is durable chat evidence of the handoff.',
      'Reply with one short sentence that contains the literal envelope id.',
    ].join(' ');
  }
}

export class Consumer extends HandoffThink {
  getSystemPrompt() {
    return [
      'You are the Consumer agent in a cross-agent handoff demo.',
      'The Worker fetched a verified envelope from the durable HandoffStore and is giving you the literal token from that envelope.',
      'Your only job is to confirm receipt by echoing the literal token back in your reply.',
      'Do not invent values. Use exactly the token the Worker provided.',
    ].join(' ');
  }
}

interface StoredEnvelopeRecord {
  envelope: HandoffEnvelope;
  storedAt: string;
  consumerSubmissionId?: string;
  consumerStatus?: string;
}

export class HandoffStore extends DurableObject<Env> {
  async put(envelope: HandoffEnvelope): Promise<StoredEnvelopeRecord> {
    const verified = await verifyEnvelope(envelope);
    const record: StoredEnvelopeRecord = { envelope: verified, storedAt: new Date().toISOString() };
    await this.ctx.storage.put(verified.envelopeId, record);
    await this.ctx.storage.put(`__last__`, verified.envelopeId);
    return record;
  }

  async get(envelopeId: string): Promise<StoredEnvelopeRecord | null> {
    const record = (await this.ctx.storage.get<StoredEnvelopeRecord>(envelopeId)) ?? null;
    if (!record) return null;
    // Re-verify on read: durable evidence must still be self-consistent.
    await verifyEnvelope(record.envelope);
    return record;
  }

  async annotateConsumer(
    envelopeId: string,
    annotation: { consumerSubmissionId: string; consumerStatus: string },
  ): Promise<StoredEnvelopeRecord | null> {
    const existing = await this.ctx.storage.get<StoredEnvelopeRecord>(envelopeId);
    if (!existing) return null;
    const next: StoredEnvelopeRecord = { ...existing, ...annotation };
    await this.ctx.storage.put(envelopeId, next);
    return next;
  }
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

async function getProducer(env: Env, sessionId: string) {
  return getAgentByName(env.Producer, sessionId, { routingRetry: { maxAttempts: 3 } });
}

async function getConsumer(env: Env, sessionId: string) {
  return getAgentByName(env.Consumer, sessionId, { routingRetry: { maxAttempts: 3 } });
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

async function chatOnce(
  stub: unknown,
  message: string,
): Promise<{ answer: string; error?: string }> {
  const s = stub as { chat: (m: string, cb: StreamCallback) => Promise<void> };
  let answer = '';
  let error: string | undefined;
  await s.chat(message, {
    onStart() {},
    onEvent(raw) {
      try {
        const chunk = JSON.parse(raw) as UIMessageChunk;
        if (chunk.type === 'text-delta') answer += chunk.delta ?? chunk.text ?? '';
      } catch {
        // non-JSON control frames carry no answer text
      }
    },
    onDone() {},
    onError(m) {
      error = m;
    },
  });
  return { answer, error };
}

async function submitOnce(
  stub: unknown,
  message: string,
  metadata: Record<string, unknown>,
  idempotencyKey: string,
): Promise<SubmitMessagesResult> {
  const s = stub as {
    submitMessages: (
      messages: ReturnType<typeof userMessage>[],
      options?: { idempotencyKey?: string; metadata?: Record<string, unknown> },
    ) => Promise<SubmitMessagesResult>;
  };
  return s.submitMessages([userMessage(message)], { idempotencyKey, metadata });
}

async function inspectOnce(stub: unknown, submissionId: string): Promise<unknown> {
  const s = stub as { inspectSubmission: (id: string) => Promise<unknown> };
  return s.inspectSubmission(submissionId);
}

function handoffStub(env: Env, envelopeId: string) {
  // Single global store DO per envelopeId — durable evidence channel.
  const id = env.HandoffStore.idFromName(envelopeId);
  return env.HandoffStore.get(id);
}

interface ProduceBody {
  producerSessionId?: string;
  consumerSessionId?: string;
  token?: string;
  intent?: string;
}

async function produce(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ProduceBody;
  if (!body.token || !body.intent || !body.producerSessionId || !body.consumerSessionId) {
    return json(
      { ok: false, error: 'producerSessionId, consumerSessionId, token, intent are required' },
      { status: 400 },
    );
  }
  const envelopeId = `env-${crypto.randomUUID()}`;
  const envelope = await buildEnvelope({
    envelopeId,
    producerSessionId: body.producerSessionId,
    consumerSessionId: body.consumerSessionId,
    token: body.token,
    intent: body.intent,
  });

  // 1. Persist the typed envelope in the durable store — this is the transfer channel.
  const store = handoffStub(env, envelopeId);
  const stored = await store.put(envelope);

  // 2. Produce durable chat evidence on the Producer agent. We submit (not chat)
  //    so the audit lives in Think's own submission log and is observable via
  //    inspectSubmission(). The envelope is attached as submission metadata.
  const producer = await getProducer(env, body.producerSessionId);
  const submission = await submitOnce(
    producer,
    `Envelope ${envelopeId} is ready for handoff. Acknowledge the id.`,
    { example: 'cross-agent-handoff-envelope', role: 'producer', envelopeId, envelope },
    `produce-${envelopeId}`,
  );

  return json({
    ok: true,
    envelopeId,
    envelope: stored.envelope,
    storedAt: stored.storedAt,
    producer: { sessionId: body.producerSessionId, submission },
  });
}

interface ConsumeBody {
  envelopeId?: string;
}

async function consume(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ConsumeBody;
  if (!body.envelopeId) {
    return json({ ok: false, error: 'envelopeId is required' }, { status: 400 });
  }

  // 1. Read the envelope from the durable store and re-verify (machine-readable
  //    transfer; does NOT rely on the producer's chat history).
  const store = handoffStub(env, body.envelopeId);
  const record = await store.get(body.envelopeId);
  if (!record) {
    return json({ ok: false, error: `envelope ${body.envelopeId} not found` }, { status: 404 });
  }
  const envelope = await verifyEnvelope(record.envelope);

  // 2. Hand the verified token to the Consumer agent — a *different* DO/session
  //    than the producer. We submit so we get a durable submissionId.
  const consumer = await getConsumer(env, envelope.consumer.sessionId);
  const submission = await submitOnce(
    consumer,
    `Echo the literal token exactly: ${envelope.payload.token}`,
    {
      example: 'cross-agent-handoff-envelope',
      role: 'consumer',
      envelopeId: envelope.envelopeId,
      receivedToken: envelope.payload.token,
      receivedIntent: envelope.payload.intent,
    },
    `consume-${envelope.envelopeId}`,
  );

  // 3. Annotate the durable record so the store carries machine-readable proof
  //    of which consumer submission picked up this envelope.
  const annotated = await store.annotateConsumer(envelope.envelopeId, {
    consumerSubmissionId: submission.submissionId,
    consumerStatus: submission.status,
  });

  return json({
    ok: true,
    envelopeId: envelope.envelopeId,
    envelope,
    consumer: { sessionId: envelope.consumer.sessionId, submission },
    record: annotated,
  });
}

async function inspectConsumer(
  env: Env,
  consumerSessionId: string,
  submissionId: string,
): Promise<Response> {
  const consumer = await getConsumer(env, consumerSessionId);
  const submission = await inspectOnce(consumer, submissionId);
  return json({ ok: true, consumerSessionId, submission });
}

async function inspectProducer(
  env: Env,
  producerSessionId: string,
  submissionId: string,
): Promise<Response> {
  const producer = await getProducer(env, producerSessionId);
  const submission = await inspectOnce(producer, submissionId);
  return json({ ok: true, producerSessionId, submission });
}

async function getEnvelope(env: Env, envelopeId: string): Promise<Response> {
  const store = handoffStub(env, envelopeId);
  const record = await store.get(envelopeId);
  if (!record) return json({ ok: false, error: 'envelope not found' }, { status: 404 });
  return json({ ok: true, record });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        example: 'cross-agent-handoff-envelope',
        envelopeSchema: HandoffEnvelopeSchema.shape.schema.value,
        deployAccountMatchesExpected:
          Boolean(env.EXPECTED_ACCOUNT_ID) && env.EXPECTED_ACCOUNT_ID === env.DEPLOY_ACCOUNT_ID,
      });
    }

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (request.method === 'POST' && parts[0] === 'handoff' && parts[1] === 'produce') {
      return produce(request, env);
    }
    if (request.method === 'POST' && parts[0] === 'handoff' && parts[1] === 'consume') {
      return consume(request, env);
    }
    if (request.method === 'GET' && parts[0] === 'handoff' && parts[1] === 'envelope' && parts[2]) {
      return getEnvelope(env, parts[2]);
    }
    if (
      request.method === 'GET' &&
      parts[0] === 'handoff' &&
      parts[1] === 'producer' &&
      parts[2] &&
      parts[3] === 'inspect' &&
      parts[4]
    ) {
      return inspectProducer(env, parts[2], parts[4]);
    }
    if (
      request.method === 'GET' &&
      parts[0] === 'handoff' &&
      parts[1] === 'consumer' &&
      parts[2] &&
      parts[3] === 'inspect' &&
      parts[4]
    ) {
      return inspectConsumer(env, parts[2], parts[4]);
    }

    return json({ ok: false, error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
