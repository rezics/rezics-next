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

function names(selection: ReturnType<typeof affectedTests>) {
  return selection.kind === 'tests'
    ? { kind: selection.kind, tests: selection.tests.map(({ file }) => file) }
    : selection;
}

function select(...changed: string[]) {
  return names(affectedTests(root, join(root, kernel), changed));
}

type Reach = { module: string; site: string; globs: string[] }[];

function selectWith(reach: Reach, ...changed: string[]) {
  return names(affectedTests(root, join(root, kernel), changed, reach));
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

  test('selected tests include their shortest import distance from the changed file', () => {
    expect(affectedTests(root, join(root, kernel), ['services/kernel/src/b.ts'])).toEqual({
      kind: 'tests',
      tests: [{ file: 'test/a.test.ts', distance: 2 }],
    });
    expect(affectedTests(root, join(root, kernel), ['services/kernel/test/leaf.test.ts'])).toEqual({
      kind: 'tests',
      tests: [{ file: 'test/leaf.test.ts', distance: 0 }],
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
    const distances = affectedTests(root, join(root, kernel), ['services/kernel/src/c.ts']);
    expect(distances.kind).toBe('tests');
    if (distances.kind === 'tests') {
      expect(distances.tests.find(({ file }) => file === 'test/computed.test.ts')).toEqual({
        file: 'test/computed.test.ts',
        distance: null,
      });
      expect(distances.tests.find(({ file }) => file === 'test/nested/b.test.ts')).toEqual({
        file: 'test/nested/b.test.ts',
        distance: 1,
      });
    }
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

describe('affected test selection with computed imports', () => {
  const loader = {
    module: 'services/kernel/src/load.ts',
    site: '`./queries/${name}.sql`',
    globs: ['services/kernel/src/queries/*.sql'],
  };

  function loaderFixture() {
    write('services/kernel/src/load.ts', 'export const load = (name: string) => import(`./queries/${name}.sql`);\n');
    write('services/kernel/src/queries/one.sql', 'select 1');
    write('services/kernel/src/queries/two.sql', 'select 2');
    write('services/kernel/test/load.test.ts', "import { load } from '../src/load.ts';\nvoid load;\n");
  }

  test('a computed import listed in the reach table depends on the files it lists and stops making its importers run for every change', () => {
    loaderFixture();
    expect(select('services/kernel/src/b.ts')).toEqual({
      kind: 'tests',
      tests: ['test/a.test.ts', 'test/load.test.ts'],
    });
    expect(selectWith([loader], 'services/kernel/src/b.ts')).toEqual({ kind: 'tests', tests: ['test/a.test.ts'] });
    expect(selectWith([loader], 'services/kernel/src/queries/two.sql')).toEqual({
      kind: 'tests',
      tests: ['test/load.test.ts'],
    });
    expect(selectWith([loader], 'services/kernel/src/load.ts')).toEqual({
      kind: 'tests',
      tests: ['test/load.test.ts'],
    });

    // An importer that names the target needs no globs.
    write(
      'services/kernel/test/wrapped.test.ts',
      "const url = new URL('file:///x');\nprocess.env.DRIVER = resolve(import.meta.dir, 'drivers/one.ts');\nawait import(url.href);\n",
    );
    write('services/kernel/test/drivers/one.ts', "import { a } from '../../src/a.ts';\nexport const driver = a;\n");
    const wrapped = { module: 'services/kernel/test/wrapped.test.ts', site: 'url.href', globs: [] };
    expect(selectWith([loader, wrapped], 'services/kernel/src/b.ts')).toEqual({
      kind: 'tests',
      tests: ['test/a.test.ts', 'test/wrapped.test.ts'],
    });
    expect(selectWith([loader, wrapped], 'services/kernel/src/c.ts')).toEqual({
      kind: 'tests',
      tests: ['test/nested/b.test.ts'],
    });
    expect(selectWith([loader, wrapped], 'services/kernel/test/drivers/one.ts')).toEqual({
      kind: 'tests',
      tests: ['test/wrapped.test.ts'],
    });
  });

  test('a reach entry whose import site or files no longer exist selects the whole suite', () => {
    loaderFixture();
    const gone = { ...loader, module: 'services/kernel/src/removed.ts' };
    const moved = { ...loader, site: '`./sql/${name}.sql`' };
    const empty = { ...loader, globs: ['services/kernel/src/queries/*.txt'] };
    for (const entry of [gone, moved, empty]) {
      const selection = selectWith([loader, entry], 'services/kernel/src/b.ts');
      expect(selection.kind).toBe('all');
      if (selection.kind === 'all') expect(selection.reason).toContain(entry.module);
    }
    // An entry that is still true selects as before, and a table that is stale for one entry widens every selection.
    expect(selectWith([loader], 'services/kernel/src/b.ts').kind).toBe('tests');
    expect(selectWith([empty], 'services/kernel/src/b.ts').kind).toBe('all');
  });

  test("a path built from the module's own directory and a literal is a dependency", () => {
    write(
      'services/kernel/test/paths.test.ts',
      [
        "import { join, resolve } from 'node:path';",
        "export const first = resolve(import.meta.dir, 'fixtures/first.txt');",
        "export const second = join(import.meta.dir, 'fixtures', 'second.txt');",
        "export const third = new URL('fixtures/third.txt', import.meta.url);",
        "export const missing = resolve(import.meta.dir, 'fixtures/missing.txt');",
        "export const outside = resolve(import.meta.dir, '../../../../escape.txt');",
        '',
      ].join('\n'),
    );
    for (const name of ['first', 'second', 'third']) write(`services/kernel/test/fixtures/${name}.txt`, name);
    for (const name of ['first', 'second', 'third']) {
      expect(select(`services/kernel/test/fixtures/${name}.txt`)).toEqual({
        kind: 'tests',
        tests: ['test/paths.test.ts'],
      });
    }
    expect(select('services/kernel/test/fixtures/missing.txt')).toEqual({
      kind: 'all',
      reason: 'services/kernel/test/fixtures/missing.txt',
    });
  });

  test('an import or require call inside a string, template text or comment is not an import site', () => {
    write(
      'services/kernel/test/texts.test.ts',
      [
        "const a = 'await import(process.env.TARGET)';",
        'const b = `require(${a}) and import(x)`;',
        '// await import(process.env.TARGET);',
        '/* require(name) */',
        "const c = `${'import(y)'}`;",
        '',
      ].join('\n'),
    );
    expect(select('services/kernel/src/b.ts')).toEqual({ kind: 'tests', tests: ['test/a.test.ts'] });
    write('services/kernel/test/real.test.ts', "const a = '';\nawait import(`${a}`);\n");
    expect(select('services/kernel/src/b.ts')).toEqual({
      kind: 'tests',
      tests: ['test/a.test.ts', 'test/real.test.ts'],
    });
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

    expect(leaf.tests.map(({ file }) => file)).toEqual(['test/log.test.ts']);
    expect(
      leaf.tests
        .filter(({ file }) => !other.tests.some((candidate) => candidate.file === file))
        .map(({ file }) => file),
    ).toEqual(['test/log.test.ts']);
    expect(
      other.tests
        .filter(({ file }) => !leaf.tests.some((candidate) => candidate.file === file))
        .map(({ file }) => file),
    ).toEqual(['test/receipt.test.ts']);
    expect(leaf.tests.length).toBeLessThan(40);
  }, 30_000);
});
