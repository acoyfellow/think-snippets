import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated personal-only deploy for the cli-http-ground-truth example.
const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use ../../scripts/personal-env.sh.');
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

// Short names keep the workers.dev hostname under Cloudflare's 63-char cap.
const app = await alchemy('think-cli-http', { stage: STAGE });
const worker = await Worker('cli-http', {
  entrypoint: 'worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    CliAgent: DurableObjectNamespace('CliAgent', { className: 'CliAgent', sqlite: true }),
    // Real Cloudflare credentials so the `cf` CLI hits the live account. This
    // is the same personal token the deploy already runs with; it is bound as
    // a plain var to keep the example free of extra secret-store ceremony.
    // (A production agent would use alchemy.secret() + an app password.)
    CF_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
    CF_ACCOUNT_ID: deployAccountId,
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
