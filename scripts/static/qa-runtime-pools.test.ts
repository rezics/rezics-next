import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-6';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exceptions = [
  { file: 'tests/qa/support/persona-fixture-authority.ts', binding: 'pool',
    reason: 'Preparation-only SQL grants explicit scaffold authority, never serves requests.' },
  { file: 'tests/qa/support/joining-auth.ts', binding: 'pool',
    reason: 'Existing transient Account bootstrap prepares the OAuth fixture; outside the persona runtime repair.' },
  { file: 'tests/qa/support/rating-account.ts', binding: 'pool',
    reason: 'Existing rating Account fixture shares migration and auth lifetime; outside the persona runtime repair.' },
  { file: 'tests/qa/support/rating-aggregate.ts', binding: 'deadlinePool',
    reason: 'Dedicated one-connection pool deliberately tests checkout and blocked-query cancellation.' },
  { file: 'tests/qa/support/personas.ts', binding: 'migrationPool',
    reason: 'Preparation-only Content DDL uses production’s separate migration lane, never serves requests.' },
] as const;

function directPools(text: string): string[] {
  const source = ts.createSourceFile('support.ts', text, ts.ScriptTarget.Latest, true);
  const constructors = new Set<string>(['Pool']);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'pg') continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const imports = clause?.namedBindings;
    if (imports && ts.isNamespaceImport(imports)) namespaces.add(imports.name.text);
    if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
      if ((item.propertyName ?? item.name).text === 'Pool') constructors.add(item.name.text);
    }
  }
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && constructors.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Pool'
          && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text))) {
        found.push(ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
          ? node.parent.name.text : '<anonymous>');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('the runtime pool guard detects direct constructors, including pg aliases', () => {
  expect(directPools(`import { Pool as Database } from 'pg';
    import * as pg from 'pg'; import driver from 'pg';
    const a = new Database({}); const b = new pg.Pool({});
    const c = new driver.Pool({}); new Pool({});
    // new Pool({})
    const message = 'new Pool({})';`)).toEqual(['a', 'b', 'c', '<anonymous>']);
});

test('QA support constructs no plain runtime pools outside reasoned exceptions', () => {
  const unexpected: string[] = [];
  const used = new Set<string>();
  for (const file of new Bun.Glob('tests/qa/support/**/*.{ts,tsx,js,mjs,cjs}').scanSync({ cwd: root })) {
    for (const binding of directPools(readFileSync(`${root}/${file}`, 'utf8'))) {
      const exception = exceptions.find(item => item.file === file && item.binding === binding);
      const key = `${file}:${binding}`;
      if (!exception || used.has(key)) unexpected.push(key);
      else { expect(exception.reason.trim().length).toBeGreaterThan(0); used.add(key); }
    }
  }
  expect(unexpected, 'Runtime pools must use production boundedPool').toEqual([]);
  expect([...used].sort(), 'Remove stale pool exceptions').toEqual(
    exceptions.map(item => `${item.file}:${item.binding}`).sort());
});
