import { repositoryFiles } from '../../lib/repository-files.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript-6';
import { launchCoverage, type LaunchCoverage } from './launch-coverage.ts';

import {
  personas,
  rowOutcomes,
  outcomeTitle,
  type OutcomeCell,
  type Persona,
  type RowOutcomes,
} from './outcome-cells.ts';
export * from './outcome-cells.ts';

export function rowId(row: Pick<LaunchCoverage, 'kind' | 'capability' | 'hardCase'>): string {
  const slug = row.capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${row.kind}/${slug}${row.hardCase ? `-${row.hardCase}` : ''}`;
}

export interface LoadOutcomesOptions {
  root?: string;
  declarationsDirectory?: string;
  registry?: readonly Pick<LaunchCoverage, 'kind' | 'capability' | 'hardCase'>[];
}

function declarationFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return repositoryFiles(directory).filter(file => file.endsWith('.ts')).map(file => join(directory, file)).sort();
}

// outcomeTest supplies the title from the imported declaration; a text search
// would reject that registration, or accept a title that appears only in a comment.
function hasOutcomeTest(
  file: string,
  declarationFile: string,
  declaration: RowOutcomes,
  persona: Persona,
): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Set<string>();
  const helpers = new Set<string>();
  const tests = new Set<string>();
  const suites = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (resolve(dirname(file), module) === declarationFile && clause?.name)
      declarations.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue;
      const name = (binding.propertyName ?? binding.name).text;
      if (module === 'bun:test' && name === 'test') tests.add(binding.name.text);
      if (module === 'bun:test' && name === 'describe') suites.add(binding.name.text);
      if (
        resolve(dirname(file), module) ===
          resolve(import.meta.dir, '../../../tests/qa/support/outcome-test.ts') &&
        name === 'outcomeTest'
      )
        helpers.add(binding.name.text);
    }
  }
  const cell = declaration.cells[persona]!;
  if (cell.state === 'notApplicable') return false;
  const registered = (call: ts.CallExpression): boolean => {
    const statement = call.parent;
    if (!ts.isExpressionStatement(statement)) return false;
    const scope = statement.parent;
    if (ts.isSourceFile(scope)) return true;
    if (!ts.isBlock(scope)) return false;
    const callback = scope.parent;
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
    const suite = callback.parent;
    return (
      ts.isCallExpression(suite) &&
      ts.isIdentifier(suite.expression) &&
      suites.has(suite.expression.text) &&
      suite.arguments.includes(callback) &&
      registered(suite)
    );
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && registered(node)) {
      const [first, second, third] = node.arguments;
      const expression = node.expression;
      if (
        ts.isIdentifier(expression) &&
        helpers.has(expression.text) &&
        first &&
        ts.isIdentifier(first) &&
        declarations.has(first.text) &&
        second &&
        ts.isStringLiteral(second) &&
        second.text === persona &&
        third
      )
        found = true;
      const test = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) &&
            expression.name.text === 'failing' &&
            ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : undefined;
      const failing = ts.isPropertyAccessExpression(expression);
      if (
        test &&
        tests.has(test) &&
        first &&
        ts.isStringLiteralLike(first) &&
        second &&
        failing === (cell.state === 'pending') &&
        first.text === outcomeTitle(declaration, persona)
      )
        found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export async function loadOutcomes(
  options: LoadOutcomesOptions = {},
): Promise<Map<string, RowOutcomes>> {
  const root = resolve(options.root ?? resolve(import.meta.dir, '../../..'));
  const registry = options.registry ?? launchCoverage;
  const ids = new Set<string>();
  for (const row of registry) {
    const id = rowId(row);
    if (ids.has(id)) throw new Error(`Duplicate scope row ID: ${id}`);
    ids.add(id);
  }
  const directory = resolve(root, options.declarationsDirectory ?? 'scripts/qa/cases/outcomes');
  const outcomes = new Map<string, RowOutcomes>();
  for (const file of declarationFiles(directory)) {
    const { default: authored } = (await import(pathToFileURL(file).href)) as {
      default: RowOutcomes;
    };
    if (!authored || typeof authored !== 'object' || !authored.cells)
      throw new Error(`Missing rowOutcomes default export: ${file}`);
    const declaration = rowOutcomes(authored.rowId, authored.cells, authored);
    const id = declaration.rowId;
    if (!ids.has(id)) throw new Error(`Unknown outcome row ID: ${id} (${file})`);
    if (outcomes.has(id)) throw new Error(`Duplicate outcome row ID: ${id} (${file})`);
    for (const persona of personas) {
      const cell = declaration.cells[persona];
      if (!cell || cell.state === 'notApplicable') continue;
      const testFile = resolve(root, cell.file!);
      if (!existsSync(testFile))
        throw new Error(`Missing outcome test file for ${id} / ${persona}: ${cell.file}`);
      if (!hasOutcomeTest(testFile, file, declaration, persona)) {
        throw new Error(
          `Missing outcome test title for ${id} / ${persona}: ${cell.test} (${cell.file})`,
        );
      }
    }
    outcomes.set(id, declaration);
  }
  return outcomes;
}

export interface ScopeProgress {
  rowsInScope: number;
  rowsProved: number;
  cells: Record<OutcomeCell['state'] | 'missing', number>;
}

export async function scopeProgress(options: LoadOutcomesOptions = {}): Promise<ScopeProgress> {
  const registry = options.registry ?? launchCoverage;
  const outcomes = await loadOutcomes(options);
  const progress: ScopeProgress = {
    rowsInScope: registry.length,
    rowsProved: 0,
    cells: { proved: 0, pending: 0, notApplicable: 0, missing: 0 },
  };
  for (const row of registry) {
    const declaration = outcomes.get(rowId(row));
    let complete = true;
    for (const persona of personas) {
      const state = declaration?.cells[persona]?.state ?? 'missing';
      progress.cells[state]++;
      if (state === 'pending' || state === 'missing') complete = false;
    }
    if (complete) progress.rowsProved++;
  }
  return progress;
}

export async function printScopeProgress(): Promise<void> {
  const { rowsProved, rowsInScope, cells } = await scopeProgress();
  console.log(
    `scope: ${rowsProved}/${rowsInScope} rows proved; cells ${cells.proved} proved, ${cells.pending} pending, ` +
      `${cells.notApplicable} not applicable, ${cells.missing} missing`,
  );
}
