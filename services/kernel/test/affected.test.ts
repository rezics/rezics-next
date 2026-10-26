import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { affectedTests } from '../scripts/affected.ts';

let root = '';
const kernel = 'services/kernel';

function write(path: string, text = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function select(...changed: string[]) {
  return affectedTests(root, join(root, kernel), changed);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affected-'));
  write('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/*', 'services/*'] }));
  write(
    'packages/lib/package.json',
    JSON.stringify({ name: '@fixture/lib', exports: { '.': './src/index.ts', './extra': './src/extra.ts' } }),
  );
  write('packages/lib/src/index.ts', "import data from './data.json';\nexport const value = data;\n");
  write('packages/lib/src/data.json', '{}');
  write('packages/lib/src/extra.ts', 'export const extra = 1;\n');
  write('services/kernel/package.json', JSON.stringify({ name: '@fixture/kernel' }));
  write('services/kernel/src/a.ts', "import { b } from './b.ts';\nexport const a = b;\n");
  write(
    'services/kernel/src/b.ts',
    "import query from './b.sql';\nimport pg from 'pg';\nexport const b = [query, pg];\n",
  );
  write('services/kernel/src/b.sql', 'select 1');
  write('services/kernel/src/c.ts', "import { value } from '@fixture/lib';\nexport const c = value;\n");
  write('services/kernel/src/d.ts', "export const d = (await import('@fixture/lib/extra')).extra;\n");
  write('services/kernel/test/a.test.ts', "import { a } from '../src/a.ts';\nvoid a;\n");
  write('services/kernel/test/nested/b.test.ts', "import { c } from '../../src/c.ts';\nvoid c;\n");
  write('services/kernel/test/d.test.ts', "import { d } from '../src/d.ts';\nvoid d;\n");
  write('services/kernel/test/leaf.test.ts', 'export {};\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('affected test selection', () => {
  test('a source change selects the test files that import it, directly or through other modules', () => {
    expect(select('services/kernel/src/a.ts')).toEqual({ kind: 'tests', tests: ['test/a.test.ts'] });
    expect(select('services/kernel/src/b.ts')).toEqual({ kind: 'tests', tests: ['test/a.test.ts'] });
    expect(select('services/kernel/src/b.sql')).toEqual({ kind: 'tests', tests: ['test/a.test.ts'] });
    expect(select('services/kernel/test/leaf.test.ts')).toEqual({ kind: 'tests', tests: ['test/leaf.test.ts'] });
    expect(select('packages/lib/src/data.json')).toEqual({ kind: 'tests', tests: ['test/nested/b.test.ts'] });
    expect(select('packages/lib/src/index.ts')).toEqual({ kind: 'tests', tests: ['test/nested/b.test.ts'] });
    expect(select('packages/lib/src/extra.ts')).toEqual({ kind: 'tests', tests: ['test/d.test.ts'] });
    expect(select('services/kernel/src/b.sql', 'services/kernel/src/c.ts', './services/kernel/src/b.ts')).toEqual({
      kind: 'tests',
      tests: ['test/a.test.ts', 'test/nested/b.test.ts'],
    });
  });

  test('a test file with a computed dynamic import is selected beside any code change', () => {
    write('services/kernel/test/computed.test.ts', 'await import(process.env.TARGET!);\n');
    write('services/kernel/test/url.test.ts', "await import(new URL('../src/c.ts', import.meta.url).href);\n");
    expect(select('services/kernel/src/b.ts')).toEqual({
      kind: 'tests',
      tests: ['test/a.test.ts', 'test/computed.test.ts'],
    });
    expect(select('services/kernel/src/c.ts')).toEqual({
      kind: 'tests',
      tests: ['test/computed.test.ts', 'test/nested/b.test.ts', 'test/url.test.ts'],
    });
    expect(select('services/kernel/README.md')).toEqual({ kind: 'tests', tests: [] });
  });

  test('a change to a shared contract or to a file the graph cannot place selects the whole suite', () => {
    for (const path of [
      'services/kernel/test/support/helper.ts',
      'services/kernel/scripts/check.ts',
      'services/kernel/db/migrations/0001_core.sql',
      'services/kernel/db/schema.sql',
      'package.json',
      'packages/lib/package.json',
      'bun.lock',
      'services/kernel/tsconfig.json',
      'tsconfig.base.json',
      '.oxlintrc.json',
      'contracts/openapi.json',
    ]) {
      expect(select(path)).toEqual({ kind: 'all', reason: path });
    }

    write('services/kernel/src/orphan.ts', 'export {};\n');
    expect(select('services/kernel/src/orphan.ts')).toEqual({ kind: 'all', reason: 'services/kernel/src/orphan.ts' });
    expect(select('services/kernel/src/orphan.sql')).toEqual({ kind: 'all', reason: 'services/kernel/src/orphan.sql' });
    expect(select('services/kernel/src/a.ts', 'apps/site/src/page.tsx', 'package.json')).toEqual({
      kind: 'all',
      reason: 'apps/site/src/page.tsx',
    });
  });

  test('documentation-only changes select no test file', () => {
    write('services/kernel/test/computed.test.ts', 'await import(process.env.TARGET!);\n');
    expect(select()).toEqual({ kind: 'tests', tests: [] });
    expect(select('README.md', 'docs/guide.md', 'services/kernel/README.md')).toEqual({ kind: 'tests', tests: [] });
    expect(select('README.md', 'assets/logo.png', 'apps/site/notes.txt')).toEqual({ kind: 'tests', tests: [] });
  });

  test('a changed data file under the kernel, packages or specs that no import reaches selects the whole suite', () => {
    for (const path of [
      'services/kernel/test/fixtures/catalogue.yaml',
      'services/kernel/src/notes.txt',
      'services/kernel/src/unreached.json',
      'packages/lib/presentation/home.json',
      'packages/lib/assets/cover.png',
      'specs/vocabulary/terms.ttl',
    ]) {
      expect(select(path)).toEqual({ kind: 'all', reason: path });
    }
    expect(select('services/kernel/src/b.sql', 'specs/vocabulary/terms.ttl')).toEqual({
      kind: 'all',
      reason: 'specs/vocabulary/terms.ttl',
    });
    expect(select('packages/lib/README.md', 'specs/README.md')).toEqual({ kind: 'tests', tests: [] });
    expect(select('apps/site/data.json', 'assets/logo.png')).toEqual({ kind: 'tests', tests: [] });
    expect(select('packages/lib/src/data.json')).toEqual({ kind: 'tests', tests: ['test/nested/b.test.ts'] });
  });
});

describe('affected test selection on the repository', () => {
  const repository = resolve(import.meta.dir, '../../..');
  const module = resolve(import.meta.dir, '..');

  test('a shared test support file selects the whole suite, a leaf test file only itself', () => {
    const started = performance.now();
    const support = affectedTests(repository, module, ['services/kernel/test/support/growth.ts']);
    expect(support).toEqual({ kind: 'all', reason: 'services/kernel/test/support/growth.ts' });

    const leaf = affectedTests(repository, module, ['services/kernel/test/log.test.ts']);
    const other = affectedTests(repository, module, ['services/kernel/test/receipt.test.ts']);
    const elapsed = performance.now() - started;
    console.log(`affected: one repository selection took ${Math.round(elapsed)} ms`);
    if (leaf.kind !== 'tests' || other.kind !== 'tests') throw new Error('expected test selections');

    // Tests with a computed import are selected beside any change, so compare two leaves to see what each adds.
    expect(leaf.tests).toContain('test/log.test.ts');
    expect(leaf.tests.filter((file) => !other.tests.includes(file))).toEqual(['test/log.test.ts']);
    expect(other.tests.filter((file) => !leaf.tests.includes(file))).toEqual(['test/receipt.test.ts']);
    expect(leaf.tests.length).toBeLessThan(40);
  });
});
