import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processIdentity, sameProcess } from './process.ts';
import type { ProcessIdentity } from './types.ts';

type Owner = { token: string; process: ProcessIdentity };
function owner(directory: string): Owner | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) as Owner;
    if (!value?.token || !Number.isSafeInteger(value.process?.pid) || !value.process.start || !value.process.boot || !Number.isSafeInteger(value.process.group)) return null;
    return value;
  } catch { return null; }
}
/** Short directory leases serialize lifecycle actions, never the model's execution time. */
export function acquireDirectoryLease(directory: string): { release(): void } {
  mkdirSync(dirname(directory), { recursive: true });
  try { mkdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = owner(directory);
    if (existing ? sameProcess(existing.process) : Date.now() - statSync(directory).mtimeMs < 10000) throw new Error(`directory lease held: ${directory}`);
    // Serialize stale reclamation separately so competing reclaimers cannot delete a new lease.
    const reclaim = acquireDirectoryLease(`${directory}.reclaim`);
    try {
      const latest = owner(directory);
      if (latest && sameProcess(latest.process)) throw new Error(`directory lease held: ${directory}`);
      rmSync(directory, { recursive: true, force: true }); mkdirSync(directory);
    } finally { reclaim.release(); }
  }
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error('cannot identify lease owner');
  const token = crypto.randomUUID();
  writeFileSync(join(directory, 'owner.json'), JSON.stringify({ token, process: identity }));
  return { release() { if (owner(directory)?.token === token) rmSync(directory, { recursive: true, force: true }); } };
}
