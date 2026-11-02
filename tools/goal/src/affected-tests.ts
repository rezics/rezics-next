import { existsSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_EXTENSION = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** Return the tracked sibling tests present in the landing candidate for changed source files. */
export function siblingTestFiles(changedPaths: readonly string[], candidate: string): string[] {
  const tests = new Set<string>();
  for (const source of changedPaths) {
    if (source.startsWith('services/kernel/') || !SOURCE_EXTENSION.test(source) || TEST_EXTENSION.test(source))
      continue;
    const name = parse(source).name;
    const sameDirectory = join(dirname(source), `${name}.test.ts`);
    const workspaceTest = join('tests', `${basename(source, parse(source).ext)}.test.ts`);
    if (existsSync(join(candidate, sameDirectory))) tests.add(sameDirectory);
    else if (existsSync(join(candidate, workspaceTest))) tests.add(workspaceTest);
  }
  return [...tests].sort();
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
