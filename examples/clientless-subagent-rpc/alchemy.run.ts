import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated deploy file for examples/clientless-subagent-rpc.
// Personal-account guard is duplicated here (not imported from the shared
// alchemy.run.ts) so this example is fully self-contained and can be
// deployed or destroyed without touching the parent Worker's state.

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is required. Use examples/clientless-subagent-rpc/personal-env.sh.',
  );
}
if (!expectedPersonalAccountId) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
}
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

const app = await alchemy('clientless-subagent-rpc', { stage: STAGE });
const worker = await Worker(`clientless-subagent-rpc-${STAGE}`, {
  entrypoint: 'worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Parent: DurableObjectNamespace('Parent', { className: 'Parent', sqlite: true }),
    Child: DurableObjectNamespace('Child', { className: 'Child', sqlite: true }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
