import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Source inventory includes local additions, but never ignored build output.
 * Refresh each call so guard fixtures and newly created files remain visible. */
export function repositoryFiles(root: string): string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cannot list repository files: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter(file => existsSync(resolve(root, file))).sort();
}

export function repositoryGlob(root: string, pattern: string): string[] {
  const glob = new Bun.Glob(pattern);
  return repositoryFiles(root).filter(file => glob.match(file));
}
