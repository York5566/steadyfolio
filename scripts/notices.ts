import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = JSON.parse(await readFile('package.json','utf8'));
const pending = Object.keys(root.dependencies);
const visited = new Set<string>();
const notices: string[] = ['Third-party runtime notices for Steadyfolio\nGenerated from the installed, locked runtime dependencies.'];
while (pending.length) {
  const name = pending.shift()!;
  if (visited.has(name)) continue;
  visited.add(name);
  const folder = join('node_modules',name);
  const manifest = JSON.parse(await readFile(join(folder,'package.json'),'utf8'));
  pending.push(...Object.keys(manifest.dependencies ?? {}));
  const files = (await readdir(folder)).filter(file => /^(licen[sc]e|notice|copying)(\.|$)/i.test(file));
  if (!files.length) throw new Error(`Missing license notice for ${name}`);
  const contents = await Promise.all(files.map(file => readFile(join(folder,file),'utf8')));
  notices.push(`\n${'='.repeat(72)}\n${name} ${manifest.version} (${manifest.license})\n${contents.join('\n')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt',notices.join('\n'));
console.log(`Preserved license notices for ${visited.size} runtime packages.`);
