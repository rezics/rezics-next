import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** External packages are copied as trees; follow workspace links back to authored
 * files so cross-workspace imports cannot fall outside the runtime payload. */
export function releaseRuntimeFiles(
  source: string,
  entry = 'services/main/src/index.ts',
): string[] {
  const root = realpathSync(source);
  const files = new Set<string>();
  const pending = [realpathSync(join(root, entry))];
  const scanners = {
    ts: new Bun.Transpiler({ loader: 'ts', target: 'bun' }),
    tsx: new Bun.Transpiler({ loader: 'tsx', target: 'bun' }),
  };
  while (pending.length) {
    const file = pending.pop()!;
    const path = relative(root, file);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error(`Release import is outside the source tree: ${file}`);
    }
    if (path.split(sep).includes('node_modules') || files.has(path)) continue;
    files.add(path);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    const scanner = path.endsWith('x') ? scanners.tsx : scanners.ts;
    for (const imported of scanner
      .scanImports(readFileSync(file))
      .filter(
        (imported) =>
          !isBuiltin(imported.path) && imported.path !== 'bun' && !imported.path.startsWith('bun:'),
      )) {
      pending.push(realpathSync(Bun.resolveSync(imported.path, dirname(file))));
    }
  }
  return [...files].sort();
}

export function copyReleasePayload(source: string, destination: string): void {
  for (const directory of ['services', 'packages', 'generated', 'node_modules']) {
    copyReleaseTree(join(source, directory), join(destination, directory));
  }
  copyReleaseRuntimeFiles(source, destination);
}

export function copyReleaseRuntimeFiles(source: string, destination: string): void {
  for (const path of releaseRuntimeFiles(source)) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
}

/** Workspace links in node_modules must not pull live dev state into a release digest. */
export function copyReleaseTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    // Evaluate from the copied root: the checkout itself may live under .temp.
    filter: (path) =>
      relative(source, path)
        .split(sep)
        .every((segment) => segment !== '.cache' && segment !== '.wrangler'),
  });
}
