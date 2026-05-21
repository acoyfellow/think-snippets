/**
 * Isolated alchemy app for the concurrency-latest-vs-queue example.
 *
 * Lives in its own alchemy "app" (`concurrency-latest-vs-queue`) and its own
 * Worker (`concurrency-latest-vs-queue-${STAGE}`), so it can be deployed and
 * destroyed alongside or independent of the parent repo without colliding
 * with shared resources.
 *
 * Personal-account guard is duplicated locally on purpose — this example
 * intentionally does not edit `../../alchemy.run.ts` or `../../scripts/`.
 */
import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use ../../scripts/personal-env.sh.');
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

// Short app + worker resource names — Cloudflare subdomains must be ≤63
// chars and alchemy concatenates `<app>-<stage>-<worker>-<stage>` for the
// `*.workers.dev` hostname.
const app = await alchemy('think-conc', { stage: STAGE });
const worker = await Worker(`think-conc-${STAGE}`, {
  entrypoint: 'worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    QueueAssistant: DurableObjectNamespace('QueueAssistant', {
      className: 'QueueAssistant',
      sqlite: true,
    }),
    LatestAssistant: DurableObjectNamespace('LatestAssistant', {
      className: 'LatestAssistant',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
