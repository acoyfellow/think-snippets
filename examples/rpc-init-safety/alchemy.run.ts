import path from 'node:path';
import { fileURLToPath } from 'node:url';
import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Resolve paths relative to this file so the example works regardless of
// the shell cwd Alchemy is invoked from.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Isolated Alchemy entrypoint for the rpc-init-safety example. Deploys its
// own Worker and Durable Object namespace so it cannot collide with the
// repo-root think-snippets app. Wires the same personal-account guard so
// the example cannot accidentally target a non-personal Cloudflare account.

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is required. Use examples/rpc-init-safety/scripts/run-e2e.sh.',
  );
}
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

// Names are intentionally short. Alchemy concatenates app + worker + stage
// into the workers.dev subdomain (max 63 chars).
const app = await alchemy('ts-rpc-init', { stage: STAGE });
const worker = await Worker(`ts-rpc-init-${STAGE}`, {
  entrypoint: path.join(HERE, 'src/worker.ts'),
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    RpcSafetyAssistant: DurableObjectNamespace('RpcSafetyAssistant', {
      className: 'RpcSafetyAssistant',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
