import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker, WorkerLoader } from 'alchemy/cloudflare';

// Isolated personal-only deploy for cli-sandbox-ground-truth.
const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required. Use ../../scripts/personal-env.sh.');
if (!expectedPersonalAccountId) throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error('Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.');
}

// Short names keep the workers.dev hostname under Cloudflare's 63-char cap.
const app = await alchemy('think-cli-sbx', { stage: STAGE });
const worker = await Worker('cli-sbx', {
  entrypoint: 'src/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    CliSandbox: DurableObjectNamespace('CliSandbox', { className: 'CliSandbox', sqlite: true }),
    // Required runtime binding for the codemode DynamicWorkerExecutor sandbox.
    LOADER: WorkerLoader(),
    // Real Cloudflare credentials for the cf CLI tool (same personal token the
    // deploy already runs with; stays server-side, never enters the sandbox).
    CF_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
    CF_ACCOUNT_ID: deployAccountId,
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
