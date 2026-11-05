import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../src/test-support.ts';
import {
  INTEGRATION_TEST_FILES,
  PACKAGE_ROOT,
  formatTimings,
  parseTestTimings,
  runTestTimings,
  selectTestFiles,
} from './test-timings.ts';

function fixtureSuite(): { path: string; close(): void } {
  const directory = temporaryDirectory();
  writeFileSync(
    join(directory.path, 'bunfig.toml'),
    `[test]\npreload = [${JSON.stringify(join(import.meta.dir, '../src/test-environment.ts'))}]\n`,
  );
  writeFileSync(
    join(directory.path, 'slow.test.ts'),
    `import { expect, test } from 'bun:test';
test('slow case', async () => {
  await Bun.sleep(20);
  console.log('TMPDIR=' + process.env.TMPDIR);
  expect(true).toBe(true);
});
`,
  );
  writeFileSync(
    join(directory.path, 'fast.test.ts'),
    `import { expect, test } from 'bun:test';
test('fast case', () => {
  console.log('TMPDIR=' + process.env.TMPDIR);
  expect(1 + 1).toBe(2);
});
`,
  );
  return directory;
}

test('selects the package suite and drops integration files for the fast set', () => {
  const all = selectTestFiles(PACKAGE_ROOT, []);
  expect(all).toContain('src/test-support.test.ts');
  expect(all).toContain('scripts/test-timings.test.ts');
  for (const file of INTEGRATION_TEST_FILES) expect(all).toContain(file);
  const fast = selectTestFiles(PACKAGE_ROOT, ['--fast']);
  for (const file of INTEGRATION_TEST_FILES) expect(fast).not.toContain(file);
  expect(fast.length).toBe(all.length - INTEGRATION_TEST_FILES.length);
  expect(selectTestFiles(PACKAGE_ROOT, ['--integration'])).toEqual([...INTEGRATION_TEST_FILES]);
});

test('parses bun test lines and prints files, tests and total slowest first', () => {
  const tests = parseTestTimings(
    'src/sample.test.ts',
    ['(pass) quick [1.50ms]', '(pass) slower [0.25s]', 'not a test'].join('\n'),
  );
  expect(tests).toEqual([
    { file: 'src/sample.test.ts', name: 'quick', result: 'pass', ms: 1.5 },
    { file: 'src/sample.test.ts', name: 'slower', result: 'pass', ms: 250 },
  ]);
  const printed = formatTimings(
    [
      { file: 'src/quick.test.ts', ms: 10, status: 0, output: '' },
      { file: 'src/slow.test.ts', ms: 40, status: 0, output: '' },
    ],
    tests,
    55,
  );
  expect(printed).toContain('Files (slowest first)');
  expect(printed).toContain('Tests (slowest first)');
  expect(printed.indexOf('src/slow.test.ts')).toBeLessThan(printed.indexOf('src/quick.test.ts'));
  expect(printed.indexOf('slower')).toBeLessThan(printed.indexOf('quick'));
  expect(printed).toContain('Total: 0.055s');
});

test('runs matching files in isolated processes and prints wall times slowest first plus the total', async () => {
  const directory = fixtureSuite();
  try {
    const result = await runTestTimings({ cwd: directory.path, argv: ['fast.test.ts', 'slow.test.ts'], parallel: 2 });
    expect(result.status, result.output).toBe(0);
    expect(result.files.map((file) => file.file).sort()).toEqual(['fast.test.ts', 'slow.test.ts']);
    expect(result.output).toContain('Files (slowest first)');
    expect(result.output).toContain('Tests (slowest first)');
    expect(result.output).toMatch(/Total: \d+\.\d{3}s/);
    const slow = result.files.find((file) => file.file === 'slow.test.ts')!;
    const fast = result.files.find((file) => file.file === 'fast.test.ts')!;
    expect(slow.ms).toBeGreaterThan(fast.ms);
    expect(result.output.indexOf('slow.test.ts')).toBeLessThan(result.output.indexOf('fast.test.ts'));
    const directories = [...result.files.map((file) => /TMPDIR=(\S+)/.exec(file.output)?.[1] ?? '')];
    expect(directories[0]).not.toBe('');
    expect(directories[1]).not.toBe('');
    expect(directories[0]).not.toBe(directories[1]);
  } finally {
    directory.close();
  }
}, 30_000);
