import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript-6';
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
const pendingOutcomeIds = [
  'catalogue/import-fidelity',
  'catalogue/source-coverage',
  'catalogue/contextual-associations',
  'catalogue/credits-and-inverse',
  'catalogue/releases-and-media',
  'catalogue/supporting-information',
  'catalogue/ordered-domain-read',
  'recipes/nutrition-and-substitutions',
  'realm/identity-discovery',
  'realm/studio-inventory',
  'realm/published-author-lifecycle',
  'catalogue/search-intent',
] as const;
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
    rowsInScope: 80,
    rowsProved: 0,
    cells: { proved: 0, pending: 0, notApplicable: 0, missing: 480 },
  });
});

test('the expanded registry binds exactly twelve new rows to pending six-persona contracts', async () => {
  const outcomes = await loadOutcomes();
  const pendingIds = new Set<string>(pendingOutcomeIds);
  const rows = launchCoverage.filter(row => pendingIds.has(rowId(row)));
  expect(rows.map(rowId).sort()).toEqual([...pendingOutcomeIds].sort());
  expect(launchCoverage.filter(row => row.kind === 'catalogue').map(rowId).sort()).toEqual(
    pendingOutcomeIds.filter(id => id.startsWith('catalogue/')).sort(),
  );
  expect(launchCoverage.filter(row => !pendingIds.has(rowId(row)))).toHaveLength(68);
  expect(pendingOutcomeIds.filter(id => !outcomes.has(id)), 'Outcome owners must supply every new declaration').toEqual([]);
  for (const row of rows) {
    const id = rowId(row);
    const declaration = outcomes.get(id)!;
    const file = `tests/qa/integration/outcomes/${id}.test.ts`;
    expect(Object.keys(declaration.cells).sort(), id).toEqual([...personas].sort());
    for (const persona of personas) {
      expect(declaration.cells[persona], `${id} / ${persona}`).toMatchObject({ state: 'pending', file });
    }
    expect(row.api, id).toEqual({ missing: 'gap', reason: expect.stringContaining(file) });
    expect(row.browser, id).toMatchObject({ missing: 'gap', reason: expect.any(String) });
  }
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

test('the repository declarations load and register every proof title exactly once', async () => {
  // Use the same root and defaults as status, scope and admission; do not replace declarations with fixtures.
  const outcomes = await loadOutcomes();
  for (const declaration of outcomes.values()) {
    for (const persona of personas) {
      const cell = declaration.cells[persona];
      if (!cell || cell.state === 'notApplicable') continue;
      const file = resolve(root, cell.file!);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const helpers = new Set<string>();
      const tests = new Set<string>();
      const suites = new Set<string>();
      const titles = new Set<string>();
      const rows = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const importedFile = resolve(dirname(file), statement.moduleSpecifier.text);
        if (statement.importClause?.name && !statement.importClause.isTypeOnly &&
          importedFile.startsWith(join(root, 'scripts/qa/cases/outcomes/'))) {
          const imported = await import(pathToFileURL(importedFile).href) as { default: { rowId: string } };
          if (imported.default.rowId === declaration.rowId) rows.add(statement.importClause.name.text);
        }
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
        for (const binding of bindings.elements) {
          if (binding.isTypeOnly) continue;
          const name = (binding.propertyName ?? binding.name).text;
          if (name === 'outcomeTest' && resolve(dirname(file), statement.moduleSpecifier.text) === helperFile)
            helpers.add(binding.name.text);
          if (name === 'test' && statement.moduleSpecifier.text === 'bun:test') tests.add(binding.name.text);
          if (name === 'describe' && statement.moduleSpecifier.text === 'bun:test') suites.add(binding.name.text);
          if (name === 'outcomeTitle' && [moduleFile, cellsModuleFile].includes(importedFile)) titles.add(binding.name.text);
        }
      }
      const title = outcomeTitle(declaration, persona);
      let registrations = 0;
      let proofRegistrations = 0;
      const registered = (call: ts.CallExpression): boolean => {
        if (!ts.isExpressionStatement(call.parent)) return false;
        const scope = call.parent.parent;
        if (ts.isSourceFile(scope)) return true;
        if (!ts.isBlock(scope)) return false;
        const callback = scope.parent;
        if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
        const suite = callback.parent;
        return ts.isCallExpression(suite) && ts.isIdentifier(suite.expression) &&
          suites.has(suite.expression.text) && suite.arguments.includes(callback) && registered(suite);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && registered(node)) {
          const [first, second] = node.arguments;
          const expression = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression;
          if (ts.isIdentifier(expression)) {
            if (ts.isIdentifier(node.expression) && helpers.has(expression.text) && first && ts.isIdentifier(first) && rows.has(first.text) &&
              second && ts.isStringLiteral(second) && second.text === persona) {
              registrations++;
              proofRegistrations++;
            }
            const titleCall = first && ts.isCallExpression(first) && ts.isIdentifier(first.expression) &&
              titles.has(first.expression.text) && first.arguments[0] && ts.isIdentifier(first.arguments[0]) &&
              rows.has(first.arguments[0].text) && first.arguments[1] && ts.isStringLiteral(first.arguments[1]) &&
              first.arguments[1].text === persona;
            if ((ts.isIdentifier(node.expression) || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'failing')) &&
              tests.has(expression.text) && first && (titleCall || (ts.isStringLiteralLike(first) && first.text === title)))
              registrations++;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(proofRegistrations, `Missing outcome test title for ${declaration.rowId} / ${persona}: ${cell.test} (${cell.file})`).toBeGreaterThan(0);
      expect(registrations, `Duplicate outcome test title for ${declaration.rowId} / ${persona}: ${cell.test} (${cell.file})`).toBe(1);
    }
  }
});

test('declarations and outcomeTest reach only loader-free cells during integration planning', () => {
  const data = fixture();
  const copied = new Set<string>();
  const copySupport = (file: string): void => {
    if (copied.has(file)) return;
    // The fixture deliberately has no loader: importing it must still break planning.
    expect(file, 'Integration planning reaches the declaration loader').not.toBe(moduleFile);
    copied.add(file);
    const source = readFileSync(file, 'utf8');
    const path = relative(root, file);
    data.write(path, source);
    if (!/^(tests\/|scripts\/(qa|fixture|dev)\/)/.test(path)) return;
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      copySupport(resolve(dirname(file), imported.fileName));
    }
  };
  copySupport(cellsModuleFile);
  copySupport(helperFile);
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
