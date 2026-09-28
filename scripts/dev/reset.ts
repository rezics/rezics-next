import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { projectName, stackDirectory, type StackOptions } from './config.ts';

/** Only the fixed shared dev project or this checkout's isolated worktree project. */
export function devResetTarget(root: string, worktree: boolean): StackOptions {
  if (!worktree) return { profile: 'dev' };
  const runId = `wt-${basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 31);
  return { profile: 'qa', runId, accountsApp: true };
}

export function devResetPlan(root: string, options: StackOptions, savedApps?: Record<string, string>) {
  const expected = devResetTarget(root, options.profile === 'qa');
  if (projectName(options) !== projectName(expected) || options.persistent || options.rawUpdate) {
    throw new Error('dev:reset accepts only the fixed dev project or this worktree backend');
  }
  const dir = stackDirectory(root, expected);
  const objects = join(dir, 'objects');
  const candidates = join(dir, 'candidates');
  if (savedApps && (resolve(savedApps.MAIN_OBJECT_DIRECTORY ?? '') !== objects
    || resolve(savedApps.MAIN_CANDIDATE_DIRECTORY ?? '') !== candidates)) {
    throw new Error('Saved dev object paths differ from this stack; no data was removed');
  }
  return { project: projectName(expected), dir, saved: existsSync(join(dir, 'compose.env')),
    volumes: ['postgres_data', 'fuseki_data', 'rustfs_data'].map(name => `${projectName(expected)}_${name}`),
    files: [objects, candidates, join(dir, 'content-rebuild.json'), join(dir, 'recovery-backups')] };
}
