import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker } from 'alchemy/cloudflare';

// Isolated example deploy. Lives in its own Alchemy app so it cannot
// share state with the root think-snippets app and is fully destroyable.
const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use scripts/personal-env.sh.');
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

// Short app + worker names: Cloudflare appends Alchemy's resource path to the
// Workers subdomain and rejects names >63 chars.
const app = await alchemy('think-ws-search', { stage: STAGE });
const worker = await Worker(`think-ws-search-${STAGE}`, {
  entrypoint: 'src/worker.ts',
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
