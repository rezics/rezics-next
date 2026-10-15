import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Source inventory includes local additions, but never ignored build output.
 * Refresh each call so guard fixtures and newly created files remain visible. */
/** A root that is not its own Git work tree (a fixture directory, often under ignored `.temp/`) is listed from disk:
 * Git would report nothing for an ignored directory. */
function fixtureFiles(root: string): string[] {
  const skip = new Set(['node_modules', '.git', 'dist']);
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files;
}

export function repositoryFiles(root: string, accept: (file: string) => boolean = () => true): string[] {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) {
    return [...new Set(fixtureFiles(root))].filter(file => accept(file)).sort();
  }
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cannot list repository files: ${result.error ?? result.stderr ?? result.signal}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter(file => accept(file) && existsSync(resolve(root, file))).sort();
}

export function repositoryGlob(root: string, pattern: string): string[] {
  const glob = new Bun.Glob(pattern);
  return repositoryFiles(root, file => glob.match(file));
}
