import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { writeReyloProject } from '../scripts/reylo-project.ts';

const kernel = resolve(import.meta.dir, '..');

test.each([
  {
    url: 'postgres://rezics@127.0.0.1:5432/kernel_analysis?sslmode=disable',
    expected: 'direct_url: "postgres://rezics@127.0.0.1:5432/kernel_analysis?sslmode=disable"\n',
  },
  { url: '', expected: 'direct_url: ""\n' },
  { url: 'quoted"url\nnext', expected: 'direct_url: "quoted\\\"url\\nnext"\n' },
])('the narrow project writer preserves exact config bytes for $url', ({ url, expected }) => {
  const temporary = resolve(kernel, '.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(resolve(temporary, 'reylo-project-'));
  try {
    const expectedPath = resolve(directory, '.reylo.yaml');
    writeFileSync(expectedPath, 'stale configuration\n');
    const config = writeReyloProject(relative(process.cwd(), directory), url);
    expect(config).toBe(expectedPath);
    expect(readFileSync(config, 'utf8')).toBe(expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the standalone writer has only filesystem and path dependencies and Web resolves that narrow module', () => {
  const scanner = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  const writer = resolve(kernel, 'scripts/reylo-project.ts');
  const imports = scanner.scanImports(readFileSync(writer, 'utf8')).map(({ path }) => path);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((path) => path === 'node:fs' || path === 'node:path')).toBe(true);
  const stack = resolve(kernel, '../../apps/web/tests/native/stack.ts');
  const stackImports = scanner.scanImports(readFileSync(stack, 'utf8')).map(({ path }) => path);
  expect(stackImports).toContain('../../../../services/kernel/scripts/reylo-project.ts');
  expect(scanner.scan(readFileSync(writer, 'utf8')).exports).toEqual(['writeReyloProject']);
});
