// Isolated alchemy entrypoint for the tool-approval-headless example.
// This deploys a separate Worker (`tool-approval-headless-<stage>`) so the
// example never touches the root `think-snippets-*` deployment.

import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use ../../scripts/personal-env.sh.');
}
if (!expectedPersonalAccountId) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
}
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

const app = await alchemy('tool-approval', { stage: STAGE });
const worker = await Worker(`tool-approval-${STAGE}`, {
  entrypoint: 'src/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Approver: DurableObjectNamespace('Approver', { className: 'Approver', sqlite: true }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
