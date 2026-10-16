import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';

export function dependencyAnalysisFailure(result: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'stderr' | 'error'>): string {
  return `dependency-cruiser failed (exit status ${result.status}; signal ${result.signal ?? 'none'})`
    + [result.error?.message, result.stderr?.trim()].filter(Boolean).map(detail => `: ${detail}`).join('');
}

/** Graphs share CPU permits with compilers across checkouts. A failed admission
 * never falls back to an unbounded analysis. */
export function dependencyAnalysis(root: string, args: string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' },
  run: typeof spawnSync = spawnSync): SpawnSyncReturns<string> {
  const result = run(process.execPath, [join(root, 'scripts/qa/host-admission.ts'), '--cpu', '--gib', '2', '--',
    join(root, 'node_modules/.bin/depcruise'), ...args],
  { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options,
    env: { ...(options.env ?? process.env), REZICS_QA_ADMISSION_LOG_FD: '3' },
    stdio: ['pipe', 'pipe', 'pipe', 2] });
  if (result.status !== 0) result.stderr = dependencyAnalysisFailure(result);
  return result;
}
