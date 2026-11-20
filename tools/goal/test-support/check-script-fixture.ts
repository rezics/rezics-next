import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git as repositoryGit } from '../src/merge.ts';

const checkScriptCache = new Map<string, { commit: string; files: Map<string, string> }>();

/** Copy the actual worker-check runtime closure from one immutable development commit. */
export function checkScriptFixture(ref = 'refs/heads/dev') {
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  let cached = checkScriptCache.get(ref);
  if (!cached) {
    cached = {
      commit: repositoryGit(repositoryRoot, 'rev-parse', '--verify', `${ref}^{commit}`),
      files: new Map(),
    };
    checkScriptCache.set(ref, cached);
  }
  const { commit, files } = cached;
  function read(path: string): string {
    const hit = files.get(path);
    if (hit !== undefined) return hit;
    const result = spawnSync('git', ['show', `${commit}:${path}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(result.stderr?.trim() || result.error?.message || `Could not read ${commit}:${path}`);
    files.set(path, result.stdout);
    return result.stdout;
  }
  return {
    read,
    install(root: string, transform: (path: string, source: string) => string = (_path, source) => source) {
      // remote-check reads the Docker wrapper as text. Discover the other files through runtime imports.
      const paths = new Set(['scripts/worker-check.ts', 'scripts/remote-check.ts', 'scripts/check-host/docker']);
      const aliases: Record<string, string[]> = {};
      const scanner = new Bun.Transpiler({ loader: 'ts' });
      for (const path of paths) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        const source = read(path);
        writeFileSync(target, transform(path, source));
        if (!path.endsWith('.ts')) continue;
        for (const dependency of scanner.scanImports(source.replace(/^#![^\n]*/, ''))) {
          const specifier = dependency.path;
          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            paths.add(join(dirname(path), specifier));
          } else if (specifier.startsWith('@rezics/')) {
            // Resolve workspace exports from the captured commit even in fixtures without a package installation.
            const [, name, ...subpath] = specifier.split('/');
            const directory = `packages/${name}`;
            const manifest = JSON.parse(read(`${directory}/package.json`));
            const entry = manifest.exports[subpath.length ? `./${subpath.join('/')}` : '.'];
            const module = join(directory, typeof entry === 'string' ? entry : entry.default);
            paths.add(module);
            aliases[specifier] = [`./${module}`];
          }
        }
      }
      if (Object.keys(aliases).length) {
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: aliases } }));
        paths.add('tsconfig.json');
      }
      return [...paths];
    },
  };
}
