import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { inspectProcessIdentity, processIdentity } from './process.ts';
import type { ProcessIdentity } from './process.ts';

type Owner = ProcessIdentity & { token: string };
type OwnerRead = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'owner'; owner: Owner };
function readOwner(directory: string): OwnerRead {
  let file: string | undefined;
  try {
    file = readdirSync(directory).find((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (!file) return { kind: 'absent' };
  let value: Owner;
  try {
    value = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid' };
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.start !== 'string' ||
    typeof value.boot !== 'string' ||
    typeof value.token !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(value.token)
  )
    return { kind: 'invalid' };
  // Earlier integration leases recorded start/boot identity without the process group.
  return { kind: 'owner', owner: { ...value, group: value.group ?? processIdentity(value.pid)?.group ?? 0 } };
}

export class LeaseHeldError extends Error {}

export type DirectoryLease = { release(): void };

/** Synchronous callers wait briefly for lifecycle leases, then fail with the same identifiable error. */
export function acquireDirectoryLeaseWaiting(directory: string, timeoutMs = 30_000): DirectoryLease {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return acquireDirectoryLease(directory);
    } catch (error) {
      if (!(error instanceof LeaseHeldError)) throw error;
      // This wait blocks the event loop, so a lease this process holds is never released while it waits.
      const owner = readOwner(directory);
      if (owner.kind === 'owner' && owner.owner.pid === process.pid)
        throw new LeaseHeldError(`Lease held by this process: ${directory}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LeaseHeldError(`Lease held after waiting ${timeoutMs}ms: ${directory}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, remaining));
    }
  }
}

/** Fail closed while a new owner is writing its identity. No age limit evicts a live owner. */
export function acquireDirectoryLease(directory: string): DirectoryLease {
  mkdirSync(dirname(directory), { recursive: true });
  const identity = processIdentity();
  if (!identity) throw new Error('Cannot identify lease owner');
  const token = randomUUID();
  const prepared = join(dirname(directory), `${token}.initializing`);
  try {
    fs.mkdirSync(prepared);
    fs.writeFileSync(join(prepared, `${token}.json`), JSON.stringify({ ...identity, token }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Publish a populated directory atomically: no empty new-owner window for a reaper.
        renameSync(prepared, directory);
        return {
          release() {
            try {
              unlinkSync(join(directory, `${token}.json`));
              rmdirSync(directory);
            } catch (error) {
              if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            }
          },
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      const ownerRead = readOwner(directory);
      if (ownerRead.kind === 'absent') {
        // A releasing owner can disappear after rename reports EEXIST but before its identity is read.
        try {
          rmdirSync(directory);
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
        continue;
      }
      if (ownerRead.kind === 'invalid') throw new Error(`Unrecognised lease owner: ${directory}`);
      const owner = ownerRead.owner;
      // Unknown visibility throws and leaves the occupant; a missing or reused identity is reclaimed below.
      const current = inspectProcessIdentity(owner.pid);
      if (current && current.start === owner.start && current.boot === owner.boot && current.group === owner.group)
        throw new LeaseHeldError(`Lease held: ${directory}`);
      // Delete only the dead incarnation's file. Concurrent reapers cannot erase a new token.
      try {
        unlinkSync(join(directory, `${owner.token}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        rmdirSync(directory);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    throw new LeaseHeldError(`Lease held: ${directory}`);
  } finally {
    try {
      rmSync(prepared, { recursive: true, force: true });
    } catch {
      // Keep the original initialization or acquire error.
    }
  }
}
