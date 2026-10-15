import type { RetainedFileIntegrity } from '../fixture/manifest.ts';

/** Batch tools across files: PostgreSQL custody contains thousands of small
 * files, so spawning sha256sum and stat once per file dominates verification. */
export const volumeInventoryScript = `
test -z "$(find . -type l -print -quit)"
find . -type f -exec sha256sum {} +
find . -type f -exec stat -c 'size %s %n' {} +`;

export function parseVolumeInventory(output: string): Record<string, RetainedFileIntegrity> {
  const hashes = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const line of output.split('\n').filter(line => line !== '')) {
    const hash = /^([a-f0-9]{64})  \.\/([^\t\n]+)$/.exec(line);
    const size = /^size ([0-9]+) \.\/([^\t\n]+)$/.exec(line);
    const path = (hash ?? size)?.[2];
    if (!path || path.split('/').some(part => part === '..' || !part)) {
      throw new Error('retained volume inventory is invalid');
    }
    if (hash) {
      if (hashes.has(path)) throw new Error('retained volume inventory repeats a file');
      hashes.set(path, hash[1]!);
    } else if (size) {
      if (sizes.has(path) || !Number.isSafeInteger(Number(size[1]))) throw new Error('retained volume size is invalid');
      sizes.set(path, Number(size[1]));
    }
  }
  if (!hashes.size || hashes.size !== sizes.size || [...hashes.keys()].some(path => !sizes.has(path))) {
    throw new Error('retained volume inventory is incomplete');
  }
  return Object.fromEntries([...hashes].map(([path, sha256]) => [path, { sha256, bytes: sizes.get(path)! }]));
}
