import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageDigest } from '@rezics/zone-sdk';

const slug = process.argv[2];
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  throw new Error('Usage: task zones:digest -- <official-zone-slug>');
}
const root = join(import.meta.dir, '../../apps/web/zones/official', slug);
const paths = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true }));
if (!paths.length) throw new Error(`No official Zone package: ${slug}`);
const files = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, await readFile(join(root, path), 'utf8')] as const)));
console.log(await packageDigest(files));
