import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkPlan, planCheck, runTestFiles } from '../scripts/check.ts';

let root = '';
let kernel = '';

function write(path: string, text = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Plan a run with the given arguments and environment, as if `changed` were the paths git reports for any revision. */
function plan(args: string[], env: Record<string, string>, changed: string[], revisions: string[] = []) {
  return planCheck(args, kernel, {
    env,
    changed: (revision) => {
      revisions.push(revision);
      return changed;
    },
  });
}

/** The test files a fake file runner is handed for a plan, in the order it runs them. */
async function ran(files: string[]): Promise<string[]> {
  const seen: string[] = [];
  await runTestFiles(files, {}, 2, {
    create: () => undefined,
    run: (file) => {
      seen.push(file);
    },
    drop: () => undefined,
  });
  return seen.sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-affected-'));
  kernel = join(root, 'services/kernel');
  write('package.json', JSON.stringify({ name: 'fixture', workspaces: ['services/*'] }));
  write('services/kernel/package.json', JSON.stringify({ name: '@fixture/kernel' }));
  write('services/kernel/src/a.ts', 'export const a = 1;\n');
  write('services/kernel/src/b.ts', 'export const b = 2;\n');
  write('services/kernel/test/a.test.ts', "import { a } from '../src/a.ts';\nvoid a;\n");
  write('services/kernel/test/b.test.ts', "import { b } from '../src/b.ts';\nvoid b;\n");
  write('services/kernel/test/nested/c.test.ts', "import { a } from '../../src/a.ts';\nvoid a;\n");
  write('services/kernel/test/leaf.test.ts', 'export {};\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('affected mode', () => {
  test('affected mode runs exactly the selected test files, and the whole suite when the selector says all', async () => {
    const selected = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['services/kernel/src/a.ts']);
    expect(selected.plan).toEqual(checkPlan(['test/a.test.ts', 'test/nested/c.test.ts'], kernel));
    expect(selected.announcement).toBe('Affected mode: tests, 2 of 4 test files selected');
    expect(await ran(selected.plan.tests)).toEqual(['test/a.test.ts', 'test/nested/c.test.ts']);

    const everything = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['services/kernel/scripts/check.ts']);
    expect(everything.plan).toEqual(checkPlan([], kernel));
    expect(everything.plan.files).toBeNull();
    expect(everything.announcement).toBe(
      'Affected mode: all, 4 of 4 test files selected (services/kernel/scripts/check.ts)',
    );
    expect(await ran(everything.plan.tests)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/leaf.test.ts',
      'test/nested/c.test.ts',
    ]);
  });

  test('an empty selection keeps the argument-run steps and runs no test file', async () => {
    const none = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['README.md']);
    expect(none.plan).toEqual({ files: [], tests: [] });
    expect(none.announcement).toBe('Affected mode: tests, 0 of 4 test files selected');
    expect(await ran(none.plan.tests)).toEqual([]);
  });

  test('the flag wins over the environment and both name the revision', () => {
    const revisions: string[] = [];
    plan(['--affected', 'origin/main'], { KERNEL_CHECK_AFFECTED: 'HEAD~1' }, [], revisions);
    plan(['--affected=feature'], {}, [], revisions);
    plan([], { KERNEL_CHECK_AFFECTED: 'HEAD~2' }, [], revisions);
    expect(revisions).toEqual(['origin/main', 'feature', 'HEAD~2']);
  });

  test('explicit file arguments and a run without the mode ignore the selector', () => {
    const revisions: string[] = [];
    const explicit = plan(
      ['test/b.test.ts'],
      { KERNEL_CHECK_AFFECTED: 'main' },
      ['services/kernel/src/a.ts'],
      revisions,
    );
    expect(explicit.plan).toEqual(checkPlan(['test/b.test.ts'], kernel));
    expect(explicit.announcement).toBeNull();

    const flagged = plan(['--affected', 'main', 'test/b.test.ts'], {}, ['services/kernel/src/a.ts'], revisions);
    expect(flagged.plan).toEqual(checkPlan(['test/b.test.ts'], kernel));
    expect(flagged.announcement).toBeNull();

    const plain = plan([], { KERNEL_CHECK_AFFECTED: '' }, ['services/kernel/src/a.ts'], revisions);
    expect(plain.plan).toEqual(checkPlan([], kernel));
    expect(plain.announcement).toBeNull();
    expect(revisions).toEqual([]);
  });

  test('a flag without a revision fails', () => {
    expect(() => plan(['--affected'], {}, [])).toThrow('--affected needs a revision');
  });
});
