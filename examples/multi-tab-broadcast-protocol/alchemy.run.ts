import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated personal-only deploy entrypoint for this example. Mirrors the repo
// root alchemy.run.ts safety rails but stands up its own Worker + DO so the
// shared `think-snippets` deployment is untouched.

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is required. Use examples/multi-tab-broadcast-protocol/scripts/run-e2e.sh.',
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

const app = await alchemy('ts-mtb', { stage: STAGE });
const worker = await Worker(`ts-mtb-${STAGE}`, {
  entrypoint: 'examples/multi-tab-broadcast-protocol/src/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Assistant: DurableObjectNamespace('Assistant', { className: 'Assistant', sqlite: true }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
