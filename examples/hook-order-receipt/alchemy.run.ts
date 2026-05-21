/**
 * Isolated alchemy entrypoint for the `hook-order-receipt` example.
 *
 * It re-applies the same personal-account safety rail as the repo-level
 * alchemy.run.ts (must be invoked through scripts/personal-env.sh) but
 * deploys its own Worker name + DurableObject namespace so it never
 * shares state with the shared `think-snippets` worker.
 */
import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use scripts/personal-env.sh.');
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

// Cloudflare *.workers.dev subdomains have a 63-char limit. Keep the
// alchemy app + Worker names short so `<worker>.<account>.workers.dev`
// fits, even when STAGE is non-trivial.
const app = await alchemy('hook-rcpt', { stage: STAGE });
const worker = await Worker(`hook-rcpt-${STAGE}`, {
  entrypoint: 'examples/hook-order-receipt/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    OrderedAssistant: DurableObjectNamespace('OrderedAssistant', { className: 'OrderedAssistant', sqlite: true }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
