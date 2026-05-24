// Guard that no example README accidentally re-adds the "Deploy to Cloudflare"
// button. This repo deploys via Alchemy, not Wrangler; the button uses
// `wrangler deploy` and is incompatible (see issue #2). The honest funnel is
// `bun run e2e:examples`, documented in the root README.

import { readdir, readFile } from 'node:fs/promises';

const examples = (await readdir(new URL('../examples/', import.meta.url), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const forbidden = 'https://deploy.workers.cloudflare.com/button';
const offenders: string[] = [];
for (const name of examples) {
  const readme = await readFile(new URL(`../examples/${name}/README.md`, import.meta.url), 'utf8');
  if (readme.includes(forbidden)) offenders.push(name);
}

if (offenders.length) {
  console.error(`Deploy to Cloudflare button is incompatible with this Alchemy stack. Remove from: ${offenders.join(', ')}`);
  process.exit(1);
}
console.log(`✓ No Deploy to Cloudflare buttons across ${examples.length} examples (Alchemy stack)`);
