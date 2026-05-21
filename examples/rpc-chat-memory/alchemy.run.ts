import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated deploy file for examples/rpc-chat-memory.
// Personal-account guard is copied here (not imported from the shared
// alchemy.run.ts) so this example is fully self-contained and can be deployed
// or destroyed without touching the parent Worker's state.

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use examples/rpc-chat-memory/personal-env.sh.');
}
if (!expectedPersonalAccountId) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
}
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

const app = await alchemy('rpc-chat-memory', { stage: STAGE });
const worker = await Worker(`rpc-chat-memory-${STAGE}`, {
  entrypoint: 'worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Memory: DurableObjectNamespace('Memory', { className: 'Memory', sqlite: true }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
