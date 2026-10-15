import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';

/** Two host-wide lanes bound dependency analysis across checkouts. Failure to
 * acquire a lane must fail closed; running outside the lock defeats the bound. */
export function dependencyAnalysis(root: string, args: string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' },
  run: typeof spawnSync = spawnSync): SpawnSyncReturns<string> {
  return run('flock', ['-w', '60', '-E', '75', `/tmp/rezics-depcruise-${process.pid % 2}.lock`,
    join(root, 'node_modules/.bin/depcruise'), ...args],
  { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });
}
