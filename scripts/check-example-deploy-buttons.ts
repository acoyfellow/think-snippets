import { readdir, readFile } from 'node:fs/promises';

const examples = (await readdir(new URL('../examples/', import.meta.url), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !['chat-rpc', 'durable-submit'].includes(name));

const expected = 'https://deploy.workers.cloudflare.com/button';
const missing: string[] = [];
for (const name of examples) {
  const readme = await readFile(new URL(`../examples/${name}/README.md`, import.meta.url), 'utf8');
  if (!readme.includes(expected)) missing.push(name);
}

if (missing.length) {
  console.error(`Missing Deploy to Cloudflare button in: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✓ Deploy to Cloudflare buttons present in ${examples.length} isolated examples`);
