import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated alchemy deploy for the scheduled-synthetic-turn example.
// Does not share state with the root think-snippets app: distinct app name
// plus a distinct Worker name prevents collision with the existing
// chat-rpc + durable-submit deploy.
//
// Names are kept short because Cloudflare composes
// "<worker>-<app>-<stage>" into the workers.dev subdomain, which has a
// 63-char limit. `think-snippets-scheduled-synthetic-turn-...` exceeds it.
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
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

const app = await alchemy('think-sched-turn', { stage: STAGE });

const worker = await Worker(`think-sched-turn-${STAGE}`, {
  entrypoint: 'src/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    ScheduledAssistant: DurableObjectNamespace('ScheduledAssistant', {
      className: 'ScheduledAssistant',
      sqlite: true,
    }),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
