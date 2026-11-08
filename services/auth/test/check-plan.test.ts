import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkPlan } from '../scripts/check.ts';

function withModule(use: (directory: string, outside: string) => void): void {
  const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const fixture = mkdtempSync(resolve(temporaryRoot, 'auth-check-fixture-'));
  const directory = resolve(fixture, 'auth');
  const outside = resolve(fixture, 'outside.ts');
  try {
    for (const file of ['src/a.ts', 'src/a.sql', 'test/b.test.ts', 'test/nested/c.test.ts', 'test/support/d.ts']) {
      const path = resolve(directory, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }
    writeFileSync(outside, '');
    use(directory, outside);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('without arguments the check runs every Auth test and checks the whole module', () => {
  withModule((directory) => {
    expect(checkPlan([], directory)).toEqual({ files: null, tests: ['test/b.test.ts', 'test/nested/c.test.ts'] });
  });
});

test('file arguments select only named files and the test files among them', () => {
  withModule((directory) => {
    expect(
      checkPlan(['test/b.test.ts', './src/a.ts', 'src/a.sql', 'test/support/d.ts', 'src/a.ts'], directory),
    ).toEqual({
      files: ['src/a.sql', 'src/a.ts', 'test/b.test.ts', 'test/support/d.ts'],
      tests: ['test/b.test.ts'],
    });
    expect(checkPlan(['src/a.ts'], directory)).toEqual({ files: ['src/a.ts'], tests: [] });
    expect(checkPlan([resolve(directory, 'test/b.test.ts')], directory)).toEqual({
      files: ['test/b.test.ts'],
      tests: ['test/b.test.ts'],
    });
  });
});

test('focused Bun filters stay test arguments while mixed file selections remain file-owned', () => {
  withModule((directory) => {
    expect(
      checkPlan(
        [
          'test/b.test.ts',
          'src/a.ts',
          '--test-name-pattern',
          'selected case',
          '--timeout',
          '12000',
          '--',
          'fixture.test.ts',
        ],
        directory,
      ),
    ).toEqual({
      files: ['src/a.ts', 'test/b.test.ts'],
      tests: ['test/b.test.ts'],
      testArguments: ['--test-name-pattern', 'selected case', '--timeout', '12000', '--', 'fixture.test.ts'],
    });
  });
});

test('paths escaping the module, missing files and directories are refused', () => {
  withModule((directory, outside) => {
    for (const argument of ['../outside.ts', outside, 'src/missing.ts', 'src']) {
      expect(() => checkPlan(['src/a.ts', argument], directory)).toThrow(
        `Check path must name an existing file inside ${directory}: ${argument}`,
      );
    }
  });
});

test('a symlink to a file outside the module is refused', () => {
  withModule((directory, outside) => {
    symlinkSync(outside, resolve(directory, 'src/link.ts'));
    expect(() => checkPlan(['src/link.ts'], directory)).toThrow('src/link.ts');
  });
});
