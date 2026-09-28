import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../work/activate.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

/** Exact snapshot bytes in the object store. The directory path matches Work manifests;
 * a configured object backend is used when the process has one. */
export async function storeExactBytes(env: WorkActivationEnvironment, bytes: Uint8Array): Promise<string> {
  if (env.workObjects) {
    const digest = await env.workObjects.put(bytes);
    const stored = await env.workObjects.get(digest);
    if (hash(stored) !== digest) throw new Error('snapshot object read-back differs');
    return digest;
  }
  return storeDirectoryBytes(env.objectDirectory, bytes);
}

function storeDirectoryBytes(directory: string, bytes: Uint8Array): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = hash(bytes);
  const target = join(directory, digest);
  if (existsSync(target)) {
    if (hash(readFileSync(target)) !== digest) throw new Error('snapshot object is corrupt');
    return digest;
  }
  const temp = join(directory, `.${digest}.${process.pid}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, target);
  if (hash(readFileSync(target)) !== digest) throw new Error('snapshot object read-back differs');
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return digest;
}
