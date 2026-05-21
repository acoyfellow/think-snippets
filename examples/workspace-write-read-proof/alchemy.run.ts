// Isolated alchemy app for examples/workspace-write-read-proof.
//
// Separate from the top-level `alchemy.run.ts` so this example owns its own
// Worker + Durable Object resources and can be deployed and destroyed
// independently without touching any other example.
//
// Same personal-account guard as the top-level app: refuses to deploy unless
// the configured CLOUDFLARE_ACCOUNT_ID equals CLOUDFLARE_PERSONAL_ACCOUNT_ID.

import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use scripts/personal-env.sh.');
}
if (!expectedPersonalAccountId) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
}
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

// Keep app + worker names short: Cloudflare workers.dev subdomains have a
// 63-char limit, and alchemy can compose multiple parts into the subdomain.
const app = await alchemy('think-snippets-ws', { stage: STAGE });
const worker = await Worker(`ts-ws-${STAGE}`, {
  entrypoint: 'worker.ts',
  cwd: import.meta.dirname,
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    WorkspaceAssistant: DurableObjectNamespace('WorkspaceAssistant', {
      className: 'WorkspaceAssistant',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
