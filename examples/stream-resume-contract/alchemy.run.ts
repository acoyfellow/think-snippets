/**
 * Isolated alchemy deployment for the stream-resume-contract example.
 *
 * Hard-fails unless the deploy account is exactly
 * `CLOUDFLARE_PERSONAL_ACCOUNT_ID`. Lives entirely under
 * examples/stream-resume-contract/ so the example can be
 * deployed and destroyed without affecting the root example app.
 */

import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId)
  throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use scripts/personal-env.sh.');
if (!expectedPersonalAccountId)
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

const app = await alchemy('ts-resume', { stage: STAGE });
const worker = await Worker(`ts-resume-${STAGE}`, {
  name: `ts-resume-${STAGE}`,
  entrypoint: 'examples/stream-resume-contract/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    StreamResumeAssistant: DurableObjectNamespace('StreamResumeAssistant', {
      className: 'StreamResumeAssistant',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
