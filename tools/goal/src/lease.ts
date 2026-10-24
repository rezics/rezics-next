import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ProcessIdentity = { pid: number; start: string; boot: string };

/** Linux start ticks and boot id prevent pid reuse from inheriting a lease. */
export function processIdentity(pid = process.pid, procRoot = '/proc'): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!fields[19] || fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return { pid, start: fields[19], boot: readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim() };
  } catch { return undefined; }
}

export function sameProcess(owner: ProcessIdentity): boolean {
  const current = processIdentity(owner.pid);
  return current?.start === owner.start && current.boot === owner.boot;
}

type Owner = ProcessIdentity & { token: string };
function readOwner(directory: string): Owner | undefined {
  try {
    const file = readdirSync(directory).find(file => file.endsWith('.json'));
    return file ? JSON.parse(readFileSync(join(directory, file), 'utf8')) as Owner : undefined;
  } catch { return undefined; }
}

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
      if (sameProcess(owner)) throw new Error(`Lease held: ${directory}`);
      // Delete only the dead incarnation's file. Concurrent reapers cannot erase a new token.
      try { unlinkSync(join(directory, `${owner.token}.json`)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try { rmdirSync(directory); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    throw new Error(`Lease held: ${directory}`);
  } finally { rmSync(prepared, { recursive: true, force: true }); }
}
