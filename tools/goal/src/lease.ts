import { randomUUID } from 'node:crypto';
import { watch, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { processIdentity, sameProcess, waitForProcess } from './process.ts';
import type { ProcessIdentity } from './process.ts';

type Owner = ProcessIdentity & { token: string };
function readOwner(directory: string): Owner | undefined {
  try {
    const file = readdirSync(directory).find(file => file.endsWith('.json'));
    if (!file) return undefined;
    const value = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Owner;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.start !== 'string' || typeof value.boot !== 'string'
      || typeof value.token !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.token)) return undefined;
    // Earlier integration leases recorded start/boot identity without the process group.
    return { ...value, group: value.group ?? processIdentity(value.pid)?.group ?? 0 };
  } catch { return undefined; }
}

export class LeaseHeldError extends Error {}

export type DirectoryLease = { release(): void };

/** Fail closed while a new owner is writing its identity. No age limit evicts a live owner. */
export function acquireDirectoryLease(directory: string): DirectoryLease {
  mkdirSync(dirname(directory), { recursive: true });
  const identity = processIdentity();
  if (!identity) throw new Error('Cannot identify lease owner');
  const token = randomUUID();
  const prepared = join(dirname(directory), `${token}.initializing`);
  mkdirSync(prepared);
  writeFileSync(join(prepared, `${token}.json`), JSON.stringify({ ...identity, token }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Publish a populated directory atomically: no empty new-owner window for a reaper.
        renameSync(prepared, directory);
        return { release() {
          try { unlinkSync(join(directory, `${token}.json`)); rmdirSync(directory); }
          catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        } };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const owner = readOwner(directory);
      if (!owner) throw new Error(`Unrecognised lease owner: ${directory}`);
      if (sameProcess(owner)) throw new LeaseHeldError(`Lease held: ${directory}`);
      // Delete only the dead incarnation's file. Concurrent reapers cannot erase a new token.
      try { unlinkSync(join(directory, `${owner.token}.json`)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try { rmdirSync(directory); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    throw new LeaseHeldError(`Lease held: ${directory}`);
  } finally { rmSync(prepared, { recursive: true, force: true }); }
}

/** Subscribe before checking ownership; a release or owner exit cannot be missed between those operations. */
export async function waitForDirectoryLease(directory: string): Promise<DirectoryLease> {
  mkdirSync(dirname(directory), { recursive: true });
  for (;;) {
    const abort = new AbortController();
    let wake!: () => void;
    const changed = new Promise<void>(resolve => { wake = resolve; });
    const watcher = watch(dirname(directory), (_, name) => { if (name === directory.split('/').at(-1)) wake(); });
    let ownerExit: Promise<void> | undefined;
    try {
      try { return acquireDirectoryLease(directory); }
      catch (error) { if (!(error instanceof LeaseHeldError)) throw error; }
      const owner = readOwner(directory);
      ownerExit = owner ? waitForProcess(owner, abort.signal) : Promise.resolve();
      await Promise.race([changed, ownerExit]);
    } finally { watcher.close(); abort.abort(); await ownerExit; }
  }
}
