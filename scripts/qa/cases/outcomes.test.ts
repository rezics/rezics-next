import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { launchCoverage } from './launch-coverage.ts';
import { scanRawSparqlIntegrationFiles } from '../isolated-integration-files.ts';
import {
  loadOutcomes,
  notApplicable,
  outcomeTitle,
  pending,
  personas,
  proved,
  rowId,
  rowOutcomes,
  scopeProgress,
} from './outcomes.ts';

const root = resolve(import.meta.dir, '../../..');
const moduleFile = join(import.meta.dir, 'outcomes.ts');
const cellsModuleFile = join(import.meta.dir, 'outcome-cells.ts');
const helperFile = join(root, 'tests/qa/support/outcome-test.ts');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(root, '.temp/persona-outcomes-'));
  directories.push(directory);
  const declarationsDirectory = join(directory, 'scripts/qa/cases/outcomes');
  mkdirSync(declarationsDirectory, { recursive: true });
  const registry = [
    { kind: 'books' as const, capability: 'Read a book' },
    { kind: 'books' as const, capability: 'Return a loan', hardCase: 'expired-loans' as const },
    { kind: 'recipes' as const, capability: 'Read a recipe' },
  ];
  const options = { root: directory, registry };
  const write = (file: string, source: string) => {
    const path = resolve(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    return path;
  };
  const declare = (id: string, cells: string, file = `${id}.ts`, rights = '{}') =>
    write(
      `scripts/qa/cases/outcomes/${file}`,
      `import { rowOutcomes, proved, pending, notApplicable } from ${JSON.stringify(cellsModuleFile)};
export default rowOutcomes(${JSON.stringify(id)}, ${cells}, ${rights});`,
    );
  return { directory, declarationsDirectory, registry, options, write, declare };
}

test('row IDs include the capability slug and hard case and are unique in the scope', async () => {
  expect(rowId({ kind: 'books', capability: 'Work hub and edition choice' })).toBe(
    'books/work-hub-and-edition-choice',
  );
  expect(
    rowId({ kind: 'books', capability: 'Return an expired loan', hardCase: 'expired-loans' }),
  ).toBe('books/return-an-expired-loan-expired-loans');
  const data = fixture();
  await expect(
    loadOutcomes({ ...data.options, registry: [data.registry[0]!, data.registry[0]!] }),
  ).rejects.toThrow('Duplicate scope row ID');
  const progress = await scopeProgress({ root: data.directory, registry: launchCoverage });
  expect(progress).toEqual({
    rowsInScope: 67,
    rowsProved: 0,
    cells: { proved: 0, pending: 0, notApplicable: 0, missing: 402 },
  });
});

test('declarations preserve rights, distinguish missing cells and default the test file', () => {
  const declaration = rowOutcomes(
    'recipes/read-a-recipe',
    {
      visitor: proved('a visitor reads the recipe'),
      stranger: pending('a stranger reads the recipe', 'custom.test.ts'),
      operator: notApplicable('No operator action'),
    },
    { rights: { basis: 'public domain', credit: 'Original author' } },
  );
  expect(declaration.cells.visitor).toEqual({
    state: 'proved',
    test: 'a visitor reads the recipe',
    file: 'tests/qa/integration/outcomes/recipes/read-a-recipe.test.ts',
  });
  expect(declaration.cells.stranger).toEqual({
    state: 'pending',
    test: 'a stranger reads the recipe',
    file: 'custom.test.ts',
  });
  expect(declaration.cells.member).toBeUndefined();
  expect(declaration.rights).toEqual({ basis: 'public domain', credit: 'Original author' });
  expect(outcomeTitle(declaration, 'visitor')).toBe(
    'recipes/read-a-recipe / visitor: a visitor reads the recipe',
  );
  expect(() => proved(' ')).toThrow('nonempty');
  expect(() => pending('title', '')).toThrow('nonempty');
  expect(() => notApplicable('')).toThrow('nonempty');
  expect(() =>
    rowOutcomes('recipes/read', {}, { rights: { basis: '', credit: 'Author' } }),
  ).toThrow('Rights basis');
  expect(() =>
    rowOutcomes('recipes/read', {}, { rights: { basis: 'License', credit: '' } }),
  ).toThrow('Rights credit');
  expect(() => rowOutcomes('recipes/read', { reader: notApplicable('reason') } as never)).toThrow(
    'Unknown outcome persona',
  );
});

test('scope counts all six personas and proves a row only when every cell is proved or not applicable', async () => {
  const data = fixture();
  data.declare(
    'books/read-a-book',
    `{ visitor: proved('visitor reads'), stranger: proved('stranger reads'),
    member: proved('member reads'), owner: notApplicable('No authoring'), moderator: notApplicable('No moderation'),
    operator: notApplicable('No operation') }`,
  );
  data.write(
    'tests/qa/integration/outcomes/books/read-a-book.test.ts',
    `import { test, describe as suite } from 'bun:test';
test('books/read-a-book / visitor: visitor reads', () => {});
test('books/read-a-book / stranger: stranger reads', () => {});
suite('member', () => { test('books/read-a-book / member: member reads', () => {}); });`,
  );
  data.declare(
    'books/return-a-loan-expired-loans',
    `{ visitor: pending('visitor denied'),
    operator: notApplicable('No operation') }`,
  );
  data.write(
    'tests/qa/integration/outcomes/books/return-a-loan-expired-loans.test.ts',
    "import { test } from 'bun:test'; test.failing('books/return-a-loan-expired-loans / visitor: visitor denied', () => {});",
  );
  expect(await scopeProgress(data.options)).toEqual({
    rowsInScope: 3,
    rowsProved: 1,
    cells: { proved: 3, pending: 1, notApplicable: 4, missing: 10 },
  });
  data.declare(
    'recipes/read-a-recipe',
    `{ ${personas.map((persona) => `${persona}: notApplicable('No recipe operation')`).join(',')} }`,
  );
  expect((await scopeProgress(data.options)).rowsProved).toBe(2);
});

test('loader recursively imports declarations and accepts outcomeTest registrations with imported aliases', async () => {
  const data = fixture();
  const declarationFile = data.declare(
    'books/read-a-book',
    `{ visitor: proved('visitor reads'), member: pending('member reads') }`,
    'nested/books/read-a-book.ts',
  );
  const testFile = 'tests/qa/integration/outcomes/books/read-a-book.test.ts';
  const declarationImport = relative(dirname(join(data.directory, testFile)), declarationFile);
  data.write(
    testFile,
    `import row from ${JSON.stringify(declarationImport)};
import { outcomeTest as check } from ${JSON.stringify(helperFile)};
check(row, 'visitor', async () => {}); check(row, 'member', async () => {});`,
  );
  const outcomes = await loadOutcomes({
    ...data.options,
    declarationsDirectory: data.declarationsDirectory,
  });
  expect([...outcomes.keys()]).toEqual(['books/read-a-book']);
  expect(outcomes.get('books/read-a-book')?.cells.member?.state).toBe('pending');
});

test('loader refuses unknown rows, duplicate declarations and a missing default export', async () => {
  const unknown = fixture();
  unknown.declare('books/unknown', '{}');
  await expect(loadOutcomes(unknown.options)).rejects.toThrow(
    'Unknown outcome row ID: books/unknown',
  );
  const duplicate = fixture();
  duplicate.declare('books/read-a-book', '{}');
  duplicate.declare('books/read-a-book', '{}', 'books/duplicate.ts');
  await expect(loadOutcomes(duplicate.options)).rejects.toThrow(
    'Duplicate outcome row ID: books/read-a-book',
  );
  const invalid = fixture();
  invalid.write('scripts/qa/cases/outcomes/books/read-a-book.ts', 'export const cells = {};');
  await expect(loadOutcomes(invalid.options)).rejects.toThrow('Missing rowOutcomes default export');
});

test('both proved and pending cells require a file and an actual test registration', async () => {
  for (const state of ['proved', 'pending']) {
    const missingFile = fixture();
    missingFile.declare('books/read-a-book', `{ visitor: ${state}('visitor reads') }`);
    await expect(loadOutcomes(missingFile.options)).rejects.toThrow('Missing outcome test file');
    for (const source of [
      "// test('visitor reads', () => {});",
      "import { test } from 'bun:test'; test('another title', () => {});",
      "import { test } from 'bun:test'; test('visitor reads', () => {});",
      "import { test } from 'bun:test'; test.skip('books/read-a-book / visitor: visitor reads', () => {});",
      `import { test, describe } from 'bun:test'; describe.skip('suite', () => {
        test${state === 'pending' ? '.failing' : ''}('books/read-a-book / visitor: visitor reads', () => {}); });`,
      `import { test } from 'bun:test'; function unused() {
        test${state === 'pending' ? '.failing' : ''}('books/read-a-book / visitor: visitor reads', () => {}); }`,
      `import { test } from 'bun:test'; test${state === 'proved' ? '.failing' : ''}('books/read-a-book / visitor: visitor reads', () => {});`,
      `import { outcomeTest } from ${JSON.stringify(helperFile)}; const row = {}; outcomeTest(row, 'visitor', () => {});`,
    ]) {
      const missingTitle = fixture();
      missingTitle.declare(
        'books/read-a-book',
        `{ visitor: ${state}('visitor reads', 'custom.test.ts') }`,
      );
      missingTitle.write('custom.test.ts', source);
      await expect(loadOutcomes(missingTitle.options)).rejects.toThrow(
        'Missing outcome test title',
      );
    }
  }
});

test('the outcomes module loads in status without importing bun:test', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', `await import(${JSON.stringify(moduleFile)});`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
});

test('declarations and outcomeTest reach only loader-free cells during integration planning', () => {
  const data = fixture();
  data.write('scripts/qa/cases/outcome-cells.ts', readFileSync(cellsModuleFile, 'utf8'));
  data.write('tests/qa/support/outcome-test.ts', readFileSync(helperFile, 'utf8'));
  data.write(
    'scripts/qa/cases/outcomes/books/read-a-book.ts',
    `import { proved, rowOutcomes } from '../../outcome-cells.ts';
export default rowOutcomes('books/read-a-book', { visitor: proved('visitor reads') });`,
  );
  const file = 'tests/qa/integration/outcomes/books/read-a-book.test.ts';
  data.write(
    file,
    `import row from '../../../../../scripts/qa/cases/outcomes/books/read-a-book.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
outcomeTest(row, 'visitor', async () => {});`,
  );
  const scan = scanRawSparqlIntegrationFiles(data.directory);
  expect(scan.roots).toEqual([file]);
  expect([...scan.files]).toEqual([]);
});
