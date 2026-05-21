// Self-contained alchemy deploy for the execute-tool-state-edit example.
//
// Lives entirely inside the example folder. Does not import or modify
// the root alchemy.run.ts. Hard-fails unless the deploy account equals
// CLOUDFLARE_PERSONAL_ACCOUNT_ID — the same personal-account safety rail
// the rest of this repo uses.
//
// Adds the worker_loaders binding required by `createExecuteTool`'s
// underlying `DynamicWorkerExecutor`.

import alchemy from 'alchemy';
import { Ai, DurableObjectNamespace, Worker, WorkerLoader } from 'alchemy/cloudflare';

const STAGE = process.env.STAGE ?? 'local';
const deployAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const expectedPersonalAccountId = process.env.CLOUDFLARE_PERSONAL_ACCOUNT_ID ?? '';

if (!deployAccountId) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID is required. Use examples/execute-tool-state-edit/scripts/personal-env.sh.',
  );
}
if (!expectedPersonalAccountId) {
  throw new Error('CLOUDFLARE_PERSONAL_ACCOUNT_ID is required.');
}
if (deployAccountId !== expectedPersonalAccountId) {
  throw new Error(
    'Refusing Cloudflare operation: CLOUDFLARE_ACCOUNT_ID is not CLOUDFLARE_PERSONAL_ACCOUNT_ID.',
  );
}

// Keep generated workers.dev hostnames under Cloudflare's 63-char cap.
const app = await alchemy('ts-exec-edit', { stage: STAGE });
const worker = await Worker('exec-edit', {
  entrypoint: 'src/worker.ts',
  compatibilityDate: '2026-05-21',
  compatibility: 'node',
  bindings: {
    AI: Ai(),
    Assistant: DurableObjectNamespace('Assistant', { className: 'Assistant', sqlite: true }),
    // Required runtime binding for DynamicWorkerExecutor.
    LOADER: WorkerLoader(),
    EXPECTED_ACCOUNT_ID: expectedPersonalAccountId,
    DEPLOY_ACCOUNT_ID: deployAccountId,
  },
});

console.log(worker.url);
await app.finalize();
