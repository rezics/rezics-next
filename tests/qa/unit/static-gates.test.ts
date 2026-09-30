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

function plain(output: string): string {
  return output.replaceAll(/\s+/g, ' ');
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
  const result = run('oxlint', ['tests/fixtures/static-boundaries/lint-failing/debugger.ts']);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('eslint(no-debugger)');
});

test('authored model and reusable packages cannot import their consumers', () => {
  const failing = run('depcruise', [
    '--config',
    '.dependency-cruiser.json',
    '--output-type',
    'err',
    'scripts/static/fixtures/failing',
  ]);
  expect(failing.code).not.toBe(0);
  expect(failing.output).toContain('authored-model-does-not-import-consumers');
  expect(failing.output).toContain('shared-packages-do-not-import-executables');
});

test('shared reads and the web host cannot grow a domain package edge', () => {
  for (const [directory, rule, file, alternative] of [
    [
      'scripts/static/fixtures/anti-silo/package-import',
      'shared-reads-do-not-depend-on-packages',
      'zone-modules/leak.ts',
      'Package solving stays optional',
    ],
    [
      'scripts/static/fixtures/anti-silo/zone-loader',
      'web-host-loads-zone-packages-through-the-loader',
      'features/load-games.tsx',
      'zones/official/index.ts',
    ],
  ] as const) {
    const failing = run('depcruise', [
      '--config',
      '.dependency-cruiser.json',
      '--output-type',
      'err-long',
      directory,
    ]);
    expect(failing.code, failing.output).not.toBe(0);
    const text = plain(failing.output);
    expect(text).toContain(rule);
    expect(text).toContain(file);
    expect(text).toContain(alternative);
    expect(text).toMatch(/1 dependency violations/);
  }
  expect(
    run('depcruise', [
      '--config',
      '.dependency-cruiser.json',
      '--output-type',
      'err-long',
      'scripts/static/fixtures/anti-silo/zone-loader/apps/web/features/load-games.stories.tsx',
    ]).code,
  ).toBe(0);
});

test('the promise gate rejects floating and misused promises with type information', () => {
  const result = run('oxlint', [
    '--type-aware',
    'tests/fixtures/static-boundaries/promise-failing/floating.ts',
  ]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('typescript(no-floating-promises)');
  expect(result.output).toContain('typescript(no-misused-promises)');
});
