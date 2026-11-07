import { existsSync } from 'node:fs';
import { dirname, join, parse, posix } from 'node:path';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_EXTENSION = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GRAPH_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/i;
const SHARED_TEST_SUPPORT = /(?:^|\/)(?:test-support|test-environment|fixtures?|__fixtures__)(?:[.\/-]|$)/i;
const WORKSPACE = /^(apps|services|packages)\/[^/]+\//;
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

function siblingNames(stem: string): string[] {
  return ['test', 'spec'].flatMap((kind) =>
    ['', 'm', 'c'].flatMap((mod) =>
      ['j', 't'].flatMap((lang) => [`${stem}.${kind}.${mod}${lang}s`, `${stem}.${kind}.${mod}${lang}sx`]),
    ),
  );
}

function siblingDirs(source: string): string[] {
  const dirs = new Set([dirname(source), 'tests']);
  const workspace = source.match(WORKSPACE)?.[0]?.slice(0, -1);
  if (workspace) {
    dirs.add(join(workspace, 'tests'));
    dirs.add(join(workspace, 'test'));
  }
  return [...dirs];
}

/** Return the tracked sibling tests present in the landing candidate for changed source files. */
export function siblingTestFiles(changedPaths: readonly string[], candidate: string | ReadonlySet<string>): string[] {
  const present =
    typeof candidate === 'string'
      ? (path: string) => existsSync(join(candidate, path))
      : (path: string) => candidate.has(path);
  const tests = new Set<string>();
  for (const source of changedPaths) {
    if (source.startsWith('services/kernel/') || !SOURCE_EXTENSION.test(source) || TEST_EXTENSION.test(source))
      continue;
    const names = siblingNames(parse(source).name);
    for (const dir of siblingDirs(source)) {
      for (const name of names) {
        const path = dir === '.' ? name : join(dir, name);
        if (present(path)) tests.add(path);
      }
    }
  }
  return [...tests].sort();
}

function importReferences(source: string): { specifier: string; typeOnly: boolean }[] {
  return [
    ...[...source.matchAll(STATIC_IMPORT)].map((match) => ({
      specifier: match[1]!,
      typeOnly:
        /^(?:import|export)\s+type\b/.test(match[0]) ||
        /^(?:import|export)\s*\{\s*type\s+[^,}]+(?:,\s*type\s+[^,}]+)*\s*\}/.test(match[0]),
    })),
    ...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => ({ specifier: match[1]!, typeOnly: false })),
  ];
}

function moduleCandidates(importer: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const extension = posix.extname(base).toLowerCase();
  let sourceVariant: string | undefined;
  if (extension === '.js') sourceVariant = `${base.slice(0, -3)}.ts`;
  else if (extension === '.mjs') sourceVariant = `${base.slice(0, -4)}.mts`;
  else if (extension === '.cjs') sourceVariant = `${base.slice(0, -4)}.cts`;
  const candidates = extension
    ? [
        base,
        ...(sourceVariant ? [sourceVariant] : []),
        ...(extension === '.js' ? [`${base.slice(0, -3)}.d.ts`] : []),
        ...(extension === '.mjs' ? [`${base.slice(0, -4)}.d.mts`] : []),
        ...(extension === '.cjs' ? [`${base.slice(0, -4)}.d.cts`] : []),
      ]
    : [
        base,
        ...['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
          (suffix) => `${base}${suffix}`,
        ),
        ...['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
          (suffix) => `${base}/index${suffix}`,
        ),
      ];
  return [...new Set(candidates)];
}

/** Shared setup is an admission boundary: changing it affects all tests; merely using it does not. */
export function isSharedTestSupport(path: string): boolean {
  return SHARED_TEST_SUPPORT.test(path);
}

/** An executable delegates to its directly imported, same-named source owner, not every utility it imports. */
export function executableSourceOwner(
  path: string,
  candidateFiles: readonly string[],
  readFile: (path: string) => string | undefined,
): string | undefined {
  if (!candidateFiles.includes(path) || !/(?:^|\/)scripts\/[^/]+\.[cm]?[jt]s$/.test(path)) return undefined;
  const source = readFile(path);
  if (!source?.startsWith('#!') || !source.includes('import.meta.main') || !/['"]--help['"]/.test(source))
    return undefined;
  const owner = path.replace('/scripts/', '/src/');
  const tracked = new Set(candidateFiles);
  return importReferences(source).some(
    ({ specifier, typeOnly }) => !typeOnly && moduleCandidates(path, specifier).includes(owner),
  ) && tracked.has(owner)
    ? owner
    : undefined;
}

/** Map each changed owner to its candidate test consumers, following source imports transitively. */
export function affectedTestFilesBySource(
  changedPaths: readonly string[],
  candidateFiles: readonly string[],
  readFile: (path: string) => string | undefined,
  options: { testedOwnerBoundaries?: boolean } = {},
): Map<string, string[]> {
  const tracked = new Set(candidateFiles);
  const reverseImports = new Map<string, Map<string, boolean>>();
  for (const importer of candidateFiles) {
    if (!GRAPH_EXTENSION.test(importer)) continue;
    const contents = readFile(importer);
    if (contents === undefined) continue;
    for (const { specifier, typeOnly } of importReferences(contents)) {
      const possible = moduleCandidates(importer, specifier);
      const targets = possible.filter((target) => tracked.has(target));
      // Retaining unresolved relative targets also reaches tests of a deleted source that still imports its old path.
      for (const target of targets.length ? targets : possible) {
        const importers = reverseImports.get(target) ?? new Map<string, boolean>();
        importers.set(importer, (importers.get(importer) ?? true) && typeOnly);
        reverseImports.set(target, importers);
      }
    }
  }

  // Entrypoint arguments and output belong to the delegated command's tests. Utility imports (DB/config)
  // are dependencies of the executable, not evidence that editing its arguments changes those utilities.
  for (const path of candidateFiles) {
    const owner = executableSourceOwner(path, candidateFiles, readFile);
    if (owner) {
      const importers = reverseImports.get(path) ?? new Map<string, boolean>();
      importers.set(owner, false);
      reverseImports.set(path, importers);
    }
  }

  const bySource = new Map<string, string[]>();
  for (const source of [...new Set(changedPaths)].sort()) {
    const affected = new Set(siblingTestFiles([source], tracked));
    if (TEST_EXTENSION.test(source) && tracked.has(source)) affected.add(source);
    const visited = new Set([source]);
    const pending = [source];
    for (let index = 0; index < pending.length; index++) {
      const dependency = pending[index]!;
      for (const [importer, typeOnly] of reverseImports.get(dependency) ?? []) {
        // A downstream type import does not execute an upstream implementation. Direct type consumers
        // and generated/declaration interfaces remain causal; Goal typing settles the remaining types.
        if (typeOnly && dependency !== source && !/\.d\.[cm]?ts$|(?:^|\/)generated(?:[-_.\/]|$)/.test(source)) continue;
        if (visited.has(importer)) continue;
        if (isSharedTestSupport(importer) && !isSharedTestSupport(source)) continue;
        visited.add(importer);
        if (TEST_EXTENSION.test(importer) && tracked.has(importer)) affected.add(importer);
        const ownerTests = options.testedOwnerBoundaries ? siblingTestFiles([importer], tracked) : [];
        ownerTests.forEach((test) => affected.add(test));
        // Test the affected consumer's public contract once. Its downstream callers keep typed contracts;
        // the independent integrated-dev verifier owns broader transitive behavioural coverage.
        if (!ownerTests.length && !TEST_EXTENSION.test(importer)) pending.push(importer);
      }
    }
    bySource.set(source, [...affected].sort());
  }
  return bySource;
}

/** Return the sorted union of test consumers for changed candidate owners. */
export function affectedTestFiles(
  changedPaths: readonly string[],
  candidateFiles: readonly string[],
  readFile: (path: string) => string | undefined,
): string[] {
  return [...new Set([...affectedTestFilesBySource(changedPaths, candidateFiles, readFile).values()].flat())].sort();
}

export function siblingTestCommand(
  files: readonly string[],
  runner: readonly string[] = ['bun', 'test'],
): string[] | undefined {
  return files.length ? [...runner, ...files] : undefined;
}

const KERNEL = 'services/kernel/';
const WEB = 'apps/web/';
const WEB_RUNNER = 'apps/web/scripts/focused.ts';

/**
 * Commands that run the tests for a worker's changed paths the way landing verification runs them, so the worker runs
 * each once before it finishes: kernel test files through the kernel check, Web test files through the focused Web
 * runner, and other changed test files with the sibling tests of changed sources through the sibling runner. Host tests
 * need a check host and are left to verification.
 */
export function workerTestCommands(
  changedPaths: readonly string[],
  worktree: string,
  runner: readonly string[] = ['bun', 'test'],
): string[][] {
  const changed = changedPaths.filter((path) => !path.startsWith('spec/') && !path.startsWith('specs/'));
  const tests = [
    ...new Set([
      ...changed.filter((path) => TEST_EXTENSION.test(path) && existsSync(join(worktree, path))),
      ...siblingTestFiles(changed, worktree),
    ]),
  ]
    .filter((path) => !/\.host\.test\./.test(path))
    .sort();
  const focusedWeb = existsSync(join(worktree, WEB_RUNNER));
  const kernel = tests.filter((path) => path.startsWith(KERNEL));
  const web = focusedWeb ? tests.filter((path) => path.startsWith(WEB)) : [];
  const other = tests.filter((path) => !kernel.includes(path) && !web.includes(path));
  const commands: string[][] = [];
  if (kernel.length)
    commands.push([
      'bun',
      'run',
      '--cwd',
      'services/kernel',
      'check',
      ...kernel.map((path) => path.slice(KERNEL.length)),
    ]);
  if (web.length)
    commands.push([
      'bun',
      WEB_RUNNER,
      '--private-network',
      '--',
      'bun',
      'test',
      ...web.map((p) => p.slice(WEB.length)),
    ]);
  if (other.length) commands.push([...runner, ...other]);
  return commands;
}
