import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { classifyCheck } from './check-placement.ts';

const repository = resolve(import.meta.dir, '..');
const temporary: string[] = [];
const testPath = 'packages/util/test/unit.test.ts';

function fixture(): string {
  const parent = join(repository, '.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `placement-closure-${randomUUID()}-`));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'packages/util/test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'packages/util/package.json'), JSON.stringify({ name: '@example/util' }));
  return root;
}

function writeTest(root: string, source: string, path = testPath): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, source);
  return path;
}

function testSource(imports = ''): string {
  return `import { test } from 'bun:test';\n${imports}\ntest('inert fixture', () => {});\n`;
}

function placement(root: string, args: string[] = ['bun', 'test', testPath]): string {
  return classifyCheck(args, root).placement;
}

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test('opaque dependencies, runtime configuration, flags, and physical escapes are remote', () => {
  const sqlite = fixture();
  writeTest(sqlite, testSource("import { Database } from 'bun:sqlite';\nvoid Database;"));
  expect(placement(sqlite)).toBe('remote');

  const ffi = fixture();
  writeTest(ffi, testSource("import { dlopen } from 'bun:ffi';\nvoid dlopen;"));
  expect(placement(ffi)).toBe('remote');

  const unknown = fixture();
  writeTest(unknown, testSource("import addon from 'unlisted-runtime-addon';\nvoid addon;"));
  expect(placement(unknown)).toBe('remote');

  const workspace = fixture();
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'], dependencies: { '@example/service': 'workspace:*' } }),
  );
  mkdirSync(join(workspace, 'packages/service'), { recursive: true });
  writeFileSync(join(workspace, 'packages/service/package.json'), JSON.stringify({ name: '@example/service' }));
  writeFileSync(
    join(workspace, 'packages/service/index.ts'),
    "Bun.serve({ fetch: () => new Response('started') });\nexport const started = true;\n",
  );
  writeTest(workspace, testSource("import { started } from '@example/service';\nvoid started;"));
  expect(placement(workspace)).toBe('remote');

  const rootPreload = fixture();
  writeFileSync(join(rootPreload, 'bunfig.toml'), '[test]\npreload = ["./preload.ts"]\n');
  writeFileSync(join(rootPreload, 'preload.ts'), 'globalThis.__placementPreloadRan = true;\n');
  writeTest(rootPreload, testSource());
  expect(placement(rootPreload)).toBe('remote');
  expect((globalThis as typeof globalThis & { __placementPreloadRan?: boolean }).__placementPreloadRan).toBeUndefined();

  const packagePreload = fixture();
  writeFileSync(join(packagePreload, 'packages/util/bunfig.toml'), '[test]\npreload = ["./setup.ts"]\n');
  writeTest(packagePreload, testSource());
  expect(placement(packagePreload)).toBe('remote');

  const unknownFlag = fixture();
  writeTest(unknownFlag, testSource());
  expect(placement(unknownFlag, ['bun', 'test', '--unreviewed-runtime-option', testPath])).toBe('remote');

  const escaped = fixture();
  const outside = mkdtempSync(join(join(repository, '.temp'), `placement-escape-${randomUUID()}-`));
  temporary.push(outside);
  const outsideSource = join(outside, 'value.ts');
  writeFileSync(outsideSource, 'globalThis.__placementEscapeRan = true;\nexport const value = 1;\n');
  const shared = join(escaped, 'packages/util/shared');
  symlinkSync(outside, shared, 'dir');
  writeTest(escaped, testSource("import { value } from '../shared/value.ts';\nvoid value;"));
  expect(placement(escaped)).toBe('remote');
  expect((globalThis as typeof globalThis & { __placementEscapeRan?: boolean }).__placementEscapeRan).toBeUndefined();
  expect(relative(escaped, outsideSource).startsWith('..')).toBe(true);
});

test('a bounded pure relative unit closure stays local and fixture sources are only classified', () => {
  const root = fixture();
  writeFileSync(join(root, 'packages/util/value.ts'), 'export const value = 1;\n');
  writeTest(root, testSource("import { value } from '../value.ts';\nvoid value;"));

  expect(placement(root)).toBe('local');
  expect((globalThis as typeof globalThis & { __placementEscapeRan?: boolean }).__placementEscapeRan).toBeUndefined();
});
