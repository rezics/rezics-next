import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const repository = resolve(import.meta.dir, '../..');
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

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
  writeFileSync(temporary, `${canonical(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function blobPath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid dataset blob digest');
  return join(root, 'raw/blobs', digest);
}

export function verifiedBlob(root: string, digest: string): Buffer {
  const bytes = readFileSync(blobPath(root, digest));
  if (sha256(bytes) !== digest) throw new Error(`Dataset blob is corrupt: ${digest}`);
  return bytes;
}

export function putBlob(root: string, bytes: Uint8Array): string {
  const digest = sha256(bytes),
    path = blobPath(root, digest);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) verifiedBlob(root, digest);
  else writeFileSync(path, bytes, { flag: 'wx' });
  return digest;
}
