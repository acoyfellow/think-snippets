import alchemy from 'alchemy';
import { Assets, Worker } from 'alchemy/cloudflare';
const STAGE = process.env.STAGE ?? 'personal';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';
if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID required. Use ../scripts/personal-env.sh.');
if (!expectedPersonalAccountId || deployAccountId !== expectedPersonalAccountId) throw new Error('Refusing non-personal Cloudflare deploy.');
const app = await alchemy('think-snippets-site', { stage: STAGE });
const worker = await Worker('think-site', {
  entrypoint: './worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  adopt: true,
  domains: STAGE === 'personal' ? [{ domainName: 'think.coey.dev', overrideExistingOrigin: true, adopt: true }] : [],
  bindings: { ASSETS: await Assets({ path: './dist' }) },
});
console.log(worker.url);
if (STAGE === 'personal') console.log('https://think.coey.dev');
await app.finalize();
