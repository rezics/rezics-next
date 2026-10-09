import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directoryLeaseState, readDirectoryLease, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { repository } from './store.ts';

export function datasetImportLockPath(context: string): string {
  if (!/^[a-f0-9]{64}$/.test(context)) throw new Error('Invalid dataset import lock context');
  return join(repository, '.temp/datasets/import-locks', context);
}
/** Distinct snapshots/epochs may run concurrently; one exact receipt context has one writer.
 * A dead process owns no live operation. Its immutable request checkpoints remain untouched. */
export function acquireDatasetImportLock(context: string): () => void {
  const directory = datasetImportLockPath(context);
  const ownerPath = join(directory, 'owner.json');
  mkdirSync(join(repository, '.temp/datasets/import-locks'), { recursive: true });
  if (existsSync(ownerPath) && !existsSync(join(directory, 'identity.json'))) {
    let owner: { pid?: unknown };
    try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: unknown }; }
    catch { throw new Error('Dataset import lock owner is invalid'); }
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
      throw new Error('Dataset import lock owner is invalid');
  }
  const state = directoryLeaseState(directory);
  if (state === 'initializing')
    throw new Error('Dataset import context is locked; its owner is still initializing');
  if (state === 'held') {
    const owner = readDirectoryLease(directory);
    throw new Error(`Dataset import context already has an active writer (PID ${owner?.pid})`);
  }
  const lease = tryAcquireDirectoryLease(directory, {
    publish: (dir, record) => {
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({
        pid: record.pid, start: record.start, boot: record.boot, token: record.token,
        context, acquiredAt: new Date().toISOString(),
      }), { mode: 0o600 });
    },
  });
  if (lease === 'held') {
    const again = directoryLeaseState(directory);
    const owner = readDirectoryLease(directory);
    if (again === 'initializing')
      throw new Error('Dataset import context is locked; its owner is still initializing');
    throw new Error(`Dataset import context already has an active writer (PID ${owner?.pid ?? 'unknown'})`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.release();
  };
}
