import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkPlan, cleanup, fileEnvironment, ownDiagnostics, startPostgresContainer } from '../scripts/check.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

/** A temporary module directory holding empty `files`, removed after `use` returns. */
function withModule(files: string[], use: (directory: string) => void): void {
  const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'kernel-check-fixture-'));
  try {
    for (const file of files) {
      mkdirSync(dirname(resolve(directory, file)), { recursive: true });
      writeFileSync(resolve(directory, file), '');
    }
    use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('without arguments the check runs every test file and the whole module', () => {
  withModule(['src/a.ts', 'test/b.test.ts', 'test/search/c.test.ts', 'test/support/d.ts'], (directory) => {
    expect(checkPlan([], directory)).toEqual({ files: null, tests: ['test/b.test.ts', 'test/search/c.test.ts'] });
  });
});

test('every check test process gets a 2000 ms pool acquisition timeout', () => {
  const env = fileEnvironment(
    { KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '100' },
    {
      url: 'postgres://rezics:rezics@127.0.0.1/rezics?',
      database: 'kernel_test_1',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig: '/tmp/reylo.yaml',
    },
  );
  expect(env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS).toBe('2000');
});

test('a focused check runs the named test files and checks only the named files', () => {
  const files = ['src/search/a.ts', 'src/search/a.sql', 'test/search/a.test.ts', 'test/search/b.test.ts'];
  withModule([...files, 'test/search/support/c.ts'], (directory) => {
    expect(
      checkPlan(
        [
          'test/search/a.test.ts',
          './src/search/a.ts',
          'src/search/a.sql',
          'test/search/support/c.ts',
          'src/search/a.ts',
        ],
        directory,
      ),
    ).toEqual({
      files: ['src/search/a.sql', 'src/search/a.ts', 'test/search/a.test.ts', 'test/search/support/c.ts'],
      tests: ['test/search/a.test.ts'],
    });
    for (const wrong of ['src/search/missing.ts', '../outside.ts', '/etc/hostname', 'src/search']) {
      expect(() => checkPlan([wrong], directory)).toThrow(wrong);
    }
  });
});

test('a directory selector with no test files is refused rather than silently selecting no checks', () => {
  withModule(
    ['src/search/a.ts', 'src/search/a.sql', 'src/other/a.test.ts', 'test/support/c.ts', 'test/a.test.ts'],
    (directory) => {
      mkdirSync(resolve(directory, 'test/empty'));
      for (const refused of ['test/empty', 'src/search', 'src/other', 'test/support']) {
        expect(() => checkPlan([refused], directory)).toThrow(refused);
        for (const valid of ['src/search/a.ts', 'test/a.test.ts']) {
          expect(() => checkPlan([valid, refused], directory)).toThrow(refused);
          expect(() => checkPlan([refused, valid], directory)).toThrow(refused);
        }
      }
    },
  );
});

test('a test directory selects its real tests without selecting support files', () => {
  withModule(
    [
      'test/other.test.ts',
      'test/search/b.test.ts',
      'test/search/nested/a.test.ts',
      'test/search/support/c.ts',
      'test/search/nested/fixture.sql',
    ],
    (directory) => {
      const tests = ['test/search/b.test.ts', 'test/search/nested/a.test.ts'];
      expect(checkPlan(['test/search'], directory)).toEqual({ files: tests, tests });
      expect(checkPlan(['./test/search', 'test/search/nested', 'test/search/b.test.ts'], directory)).toEqual({
        files: tests,
        tests,
      });
      expect(checkPlan(['test/search/nested'], directory)).toEqual({
        files: ['test/search/nested/a.test.ts'],
        tests: ['test/search/nested/a.test.ts'],
      });
    },
  );
});

test('a focused typecheck reports only diagnostics in the named files', () => {
  const output = [
    "src/search/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/access/other.ts(4,1): error TS2304: Cannot find name 'x'.",
    'test/search/a.test.ts(30,9): error TS2769: No overload matches this call.',
    "  Overload 1 of 2, '(value: number): void', gave the following error.",
    'src/access/other.ts(9,1): error TS2769: No overload matches this call.',
    "  Overload 1 of 2, '(value: number): void', gave the following error.",
    "error TS5083: Cannot read file 'tsconfig.base.json'.",
    '',
  ].join('\n');
  expect(ownDiagnostics(output, ['src/search/a.ts', 'test/search/a.test.ts'])).toEqual([
    "src/search/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "test/search/a.test.ts(30,9): error TS2769: No overload matches this call.\n  Overload 1 of 2, '(value: number): void', gave the following error.",
    "error TS5083: Cannot read file 'tsconfig.base.json'.",
  ]);
  const elsewhere = output
    .split('\n')
    .filter((line) => !line.startsWith('error'))
    .join('\n');
  expect(ownDiagnostics(elsewhere, ['src/search/b.ts'])).toEqual([]);
});

test("the check's PostgreSQL container keeps its logs when it exits early and is removed by cleanup", () => {
  const calls: string[][] = [];
  const stubDocker = (args: string[]): string => {
    calls.push(args);
    return args[0] === 'run' ? 'postgres-container' : '';
  };

  const postgresContainer = startPostgresContainer(stubDocker);

  expect(calls[0]?.[0]).toBe('run');
  expect(calls[0]).not.toContain('--rm');
  expect(postgresContainer).toBe('postgres-container');

  cleanup(['search-container', postgresContainer], stubDocker);
  expect(calls.slice(1)).toEqual([
    ['rm', '-f', '-v', 'search-container'],
    ['rm', '-f', '-v', 'postgres-container'],
  ]);
});
