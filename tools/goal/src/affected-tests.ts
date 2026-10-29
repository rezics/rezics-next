import { existsSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_EXTENSION = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** Return the tracked sibling tests present in the landing candidate for changed source files. */
export function siblingTestFiles(changedPaths: readonly string[], candidate: string): string[] {
  const tests = new Set<string>();
  for (const source of changedPaths) {
    if (source.startsWith('services/kernel/') || !SOURCE_EXTENSION.test(source) || TEST_EXTENSION.test(source)) continue;
    const name = parse(source).name;
    const sameDirectory = join(dirname(source), `${name}.test.ts`);
    const workspaceTest = join('tests', `${basename(source, parse(source).ext)}.test.ts`);
    if (existsSync(join(candidate, sameDirectory))) tests.add(sameDirectory);
    else if (existsSync(join(candidate, workspaceTest))) tests.add(workspaceTest);
  }
  return [...tests].sort();
}

export function siblingTestCommand(files: readonly string[], runner: readonly string[] = ['bun', 'test']): string[] | undefined {
  return files.length ? [...runner, ...files] : undefined;
}
