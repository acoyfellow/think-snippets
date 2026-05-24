// Deploy-button policy guard.
//
// Only `rpc-chat-memory` is button-deployable (it ships a wrangler.jsonc as a
// hybrid front-door demo). Every other example deploys via Alchemy and must
// NOT carry a "Deploy to Cloudflare" button — the button runs `wrangler
// deploy` and would fail on an Alchemy-only example. See issue #2 and the
// `## One-click deploy` section in the root README.

import { readdir, readFile } from 'node:fs/promises';

const BUTTON_URL = 'https://deploy.workers.cloudflare.com/button';
const ALLOWLIST = new Set(['rpc-chat-memory']);

const examples = (await readdir(new URL('../examples/', import.meta.url), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const offenders: string[] = [];
const missingAllowed: string[] = [];

for (const name of examples) {
  const readme = await readFile(new URL(`../examples/${name}/README.md`, import.meta.url), 'utf8');
  const has = readme.includes(BUTTON_URL);
  if (ALLOWLIST.has(name) && !has) missingAllowed.push(name);
  if (!ALLOWLIST.has(name) && has) offenders.push(name);
}

if (offenders.length) {
  console.error(
    `Examples that may not carry a Deploy to Cloudflare button (Alchemy-only stack): ${offenders.join(', ')}`,
  );
}
if (missingAllowed.length) {
  console.error(`Examples that MUST carry the button but do not: ${missingAllowed.join(', ')}`);
}
if (offenders.length || missingAllowed.length) {
  process.exit(1);
}
console.log(
  `\u2713 Deploy-button policy holds across ${examples.length} examples (allowlist: ${[...ALLOWLIST].join(', ')})`,
);
