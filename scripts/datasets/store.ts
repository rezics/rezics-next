import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../lib/canonical-json.ts';
import { readVerified, sha256, writeVerified } from '../lib/paced-fetch.ts';

export const repository = resolve(import.meta.dir, '../..');
export { sha256 };
export { canonicalJson as canonical };

/** Worktrees share the main checkout's sibling store, rather than their own ../. */
export function datasetRoot(override = process.env.REZICS_DATASET_ROOT): string {
  if (override) return resolve(override);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  return resolve(dirname(common), '../rezics-datasets');
}

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // Same-filesystem staging also supports an external store on a separate disk.
  const temporary = join(dirname(path), '.temp', `${process.pid}-${crypto.randomUUID()}.json`);
  mkdirSync(dirname(temporary), { recursive: true });
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function blobPath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid dataset blob digest');
  return join(root, 'raw/blobs', digest);
}

export function verifiedBlob(root: string, digest: string): Buffer {
  return readVerified(blobPath(root, digest), digest);
}

export function putBlob(root: string, bytes: Uint8Array): string {
  return writeVerified(blobPath(root, sha256(bytes)), bytes);
}
