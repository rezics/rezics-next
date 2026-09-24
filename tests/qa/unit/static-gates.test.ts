import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function run(binary: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [join(root, 'node_modules/.bin', binary), ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    output: `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`,
  };
}

test('the import gate scans TypeScript edges and rejects forbidden boundaries', () => {
  const passing = run('depcruise', [
    '--config',
    '.dependency-cruiser.json',
    '--output-type',
    'err',
    'tests/fixtures/static-boundaries/passing',
  ]);
  expect(passing.code).toBe(0);
  expect(passing.output).toMatch(/\(2 modules, 1 dependencies cruised\)/);

  const failing = run('depcruise', [
    '--config',
    '.dependency-cruiser.json',
    '--output-type',
    'err',
    'tests/fixtures/static-boundaries/failing',
  ]);
  expect(failing.code).not.toBe(0);
  for (const rule of [
    'web-only-uses-public-service-contract',
    'main-app-contract-is-types-only-in-web',
    'browser-code-has-no-server-dependencies',
    'main-modules-do-not-import-entrypoints',
  ])
    expect(failing.output).toContain(rule);
  expect(failing.output).toMatch(/7 modules, 4 dependencies cruised/);
});

test('the lint gate rejects a dangerous debugger statement', () => {
  const result = run('biome', [
    'lint',
    'tests/fixtures/static-boundaries/lint-failing/debugger.ts',
  ]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('lint/suspicious/noDebugger');
});
