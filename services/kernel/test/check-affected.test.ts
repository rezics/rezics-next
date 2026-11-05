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
    expect(selected.announcement).toBe('Affected mode: tests, 2 of 4 test files selected (2 reachable, cap 60)');
    expect(await ran(selected.plan.tests)).toEqual(['test/a.test.ts', 'test/nested/c.test.ts']);

    const everything = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['services/kernel/scripts/check.ts']);
    expect(everything.plan).toEqual({ files: [], tests: [] });
    expect(everything.announcement).toBe(
      'Affected mode: unverified, 0 of 4 test files selected (services/kernel/scripts/check.ts)',
    );
    expect(await ran(everything.plan.tests)).toEqual([]);
  });

  test('an empty selection keeps the argument-run steps and runs no test file', async () => {
    const none = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['README.md']);
    expect(none.plan).toEqual({ files: [], tests: [] });
    expect(none.announcement).toBe('Affected mode: tests, 0 of 4 test files selected (0 reachable, cap 60)');
    expect(await ran(none.plan.tests)).toEqual([]);
  });

  test('a wide change selects no more than the cap at 100, 800 and 6,400 test files', () => {
    const shared = 'services/kernel/src/shared.ts';
    write(shared, 'export const shared = true;\n');
    for (const total of [100, 800, 6_400]) {
      rmSync(join(kernel, 'test'), { recursive: true, force: true });
      for (let index = 0; index < total; index += 1) {
        write(`services/kernel/test/case-${String(index).padStart(4, '0')}.test.ts`, "import '../src/shared.ts';\n");
      }
      const wide = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, [shared]);
      expect(wide.plan.tests).toHaveLength(Math.min(60, total));
      expect(wide.announcement).toBe(
        `Affected mode: tests, ${Math.min(60, total)} of ${total} test files selected (${total} reachable, cap 60)`,
      );
    }
  }, 30_000);

  test('a capped selection ranks direct importers first, then shorter times, paths and opaque imports', () => {
    const changed = 'services/kernel/src/shared.ts';
    write(changed, 'export const shared = true;\n');
    write('services/kernel/src/bridge.ts', "import './shared.ts';\n");
    for (const file of ['direct-a', 'direct-b', 'direct-c', 'direct-slow', 'direct-unrecorded']) {
      write(`services/kernel/test/${file}.test.ts`, "import '../src/shared.ts';\n");
    }
    write('services/kernel/test/indirect.test.ts', "import '../src/bridge.ts';\n");
    write('services/kernel/test/opaque.test.ts', 'await import(process.env.TARGET!);\n');
    write(
      'timings/latest.json',
      JSON.stringify({
        files: {
          'test/direct-a.test.ts': { wall: 3 },
          'test/direct-b.test.ts': { wall: 2 },
          'test/direct-c.test.ts': { wall: 3 },
          'test/direct-slow.test.ts': { wall: 8 },
          'test/indirect.test.ts': { wall: 0.1 },
          'test/opaque.test.ts': { wall: 0.001 },
        },
      }),
    );
    const ranked = plan(
      [],
      {
        KERNEL_CHECK_AFFECTED: 'main',
        KERNEL_CHECK_AFFECTED_MAX: '2',
        KERNEL_CHECK_TIMINGS: join(root, 'timings'),
      },
      [changed],
    );
    expect(ranked.plan.tests).toEqual(['test/direct-a.test.ts', 'test/direct-b.test.ts']);
    expect(ranked.announcement).toBe('Affected mode: tests, 2 of 11 test files selected (7 reachable, cap 2)');

    const noMissingTime = plan(
      [],
      {
        KERNEL_CHECK_AFFECTED: 'main',
        KERNEL_CHECK_AFFECTED_MAX: '4',
        KERNEL_CHECK_TIMINGS: join(root, 'timings'),
      },
      [changed],
    );
    expect(noMissingTime.plan.tests).toEqual([
      'test/direct-a.test.ts',
      'test/direct-b.test.ts',
      'test/direct-c.test.ts',
      'test/direct-slow.test.ts',
    ]);

    const beforeOpaque = plan(
      [],
      {
        KERNEL_CHECK_AFFECTED: 'main',
        KERNEL_CHECK_AFFECTED_MAX: '6',
        KERNEL_CHECK_TIMINGS: join(root, 'timings'),
      },
      [changed],
    );
    expect(beforeOpaque.plan.tests).toEqual([
      'test/direct-a.test.ts',
      'test/direct-b.test.ts',
      'test/direct-c.test.ts',
      'test/direct-slow.test.ts',
      'test/direct-unrecorded.test.ts',
      'test/indirect.test.ts',
    ]);
  });

  test('the affected cap defaults to 60 and accepts only positive integers', () => {
    const defaultCap = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['services/kernel/src/a.ts']);
    expect(defaultCap.announcement).toContain('(2 reachable, cap 60)');
    const configured = plan([], { KERNEL_CHECK_AFFECTED: 'main', KERNEL_CHECK_AFFECTED_MAX: '3' }, [
      'services/kernel/src/a.ts',
    ]);
    expect(configured.announcement).toContain('(2 reachable, cap 3)');
    for (const value of ['', '0', '-1', '1.5', 'NaN', '9007199254740992']) {
      expect(() =>
        plan([], { KERNEL_CHECK_AFFECTED: 'main', KERNEL_CHECK_AFFECTED_MAX: value }, ['services/kernel/src/a.ts']),
      ).toThrow('KERNEL_CHECK_AFFECTED_MAX');
    }
  });

  test('a change the selector cannot place runs no tests and announces unverified', () => {
    write('services/kernel/src/orphan.ts', 'export {};\n');
    const unknown = plan([], { KERNEL_CHECK_AFFECTED: 'main' }, ['services/kernel/src/orphan.ts']);
    expect(unknown.plan).toEqual({ files: [], tests: [] });
    expect(unknown.announcement).toBe(
      'Affected mode: unverified, 0 of 4 test files selected (services/kernel/src/orphan.ts)',
    );
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
