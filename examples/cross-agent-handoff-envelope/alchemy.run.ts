// Isolated Alchemy entrypoint for the cross-agent-handoff-envelope example.
// Deploys a worker + 3 Durable Object namespaces. Refuses to operate on any
// account other than CLOUDFLARE_PERSONAL_ACCOUNT_ID.

import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is required. Use examples/cross-agent-handoff-envelope/scripts/personal-env.sh.',
  );
}
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

const app = await alchemy('ts-handoff-envelope', { stage: STAGE });
const worker = await Worker(`ts-handoff-envelope-${STAGE}`, {
  entrypoint: 'src/worker.ts',
  cwd: import.meta.dirname,
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Producer: DurableObjectNamespace('Producer', { className: 'Producer', sqlite: true }),
    Consumer: DurableObjectNamespace('Consumer', { className: 'Consumer', sqlite: true }),
    HandoffStore: DurableObjectNamespace('HandoffStore', {
      className: 'HandoffStore',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
