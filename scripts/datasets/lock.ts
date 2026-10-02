import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository } from './store.ts';

export function datasetImportLockPath(context: string): string {
  if (!/^[a-f0-9]{64}$/.test(context)) throw new Error('Invalid dataset import lock context');
  return join(repository, '.temp/datasets/import-locks', context);
}
/** Distinct snapshots/epochs may run concurrently; one exact receipt context has one writer.
 * A dead process owns no live operation. Its immutable request checkpoints remain untouched. */
export function acquireDatasetImportLock(context: string): () => void {
  const directory = datasetImportLockPath(context),
    ownerPath = join(directory, 'owner.json');
  mkdirSync(join(repository, '.temp/datasets/import-locks'), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!existsSync(ownerPath))
        throw new Error('Dataset import context is locked; its owner is still initializing');
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error('Dataset import lock owner is invalid');
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (cause) {
        dead = (cause as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (!dead || attempt > 0)
        throw new Error(`Dataset import context already has an active writer (PID ${owner.pid})`);
      rmSync(directory, { recursive: true });
    }
  }
  writeFileSync(
    ownerPath,
    JSON.stringify({ pid: process.pid, context, acquiredAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid: number };
    if (owner.pid !== process.pid) throw new Error('Dataset import lock changed owners');
    rmSync(directory, { recursive: true });
  };
}
