import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-6';

interface ModuleMock {
  call: ts.CallExpression;
  module: string | null;
  result: ts.Expression | undefined;
  cleanup: boolean;
}

function expression(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)
    || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function member(node: ts.Expression): { object: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { object: node.expression, name: node.argumentExpression.text };
  }
  return undefined;
}

function factoryResult(node: ts.Expression | undefined): ts.Expression | undefined {
  if (!node) return;
  node = expression(node);
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
  if (!ts.isBlock(node.body)) return expression(node.body);
  // Conditional factories and opaque helpers cannot prove preservation of every export.
  if (node.body.statements.length !== 1) return;
  const statement = node.body.statements[0]!;
  return ts.isReturnStatement(statement) && statement.expression ? expression(statement.expression) : undefined;
}

function inspectModuleMocks(text: string): { count: number; violations: string[] } {
  const source = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mocks = new Set<string>();
  const namespaces = new Set<string>();
  const cleanupHooks = new Set<string>();
  const imports = new Map<string, string>();
  const bindings = new Map<string, ts.VariableDeclaration>();
  const moduleAliases = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      imports.set(named.name.text, module);
      if (module === 'bun:test') namespaces.add(named.name.text);
    } else if (module === 'bun:test' && named && ts.isNamedImports(named)) {
      for (const specifier of named.elements) {
        const name = specifier.propertyName?.text ?? specifier.name.text;
        if (name === 'mock') mocks.add(specifier.name.text);
        if (name === 'afterAll' || name === 'afterEach') cleanupHooks.add(specifier.name.text);
      }
    }
  }
  const isMock = (node: ts.Expression): boolean => {
    node = expression(node);
    if (ts.isIdentifier(node)) return mocks.has(node.text);
    const property = member(node);
    return property?.name === 'mock' && ts.isIdentifier(property.object) && namespaces.has(property.object.text);
  };
  const isModule = (node: ts.Expression): boolean => {
    const property = member(expression(node));
    return property?.name === 'module' && isMock(property.object);
  };
  function collectBindings(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        bindings.set(node.name.text, node);
        if (isModule(node.initializer)) moduleAliases.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && isMock(node.initializer)) {
        for (const binding of node.name.elements) {
          if ((binding.propertyName?.getText(source) ?? binding.name.getText(source)) === 'module'
            && ts.isIdentifier(binding.name)) moduleAliases.add(binding.name.text);
        }
      }
    }
    ts.forEachChild(node, collectBindings);
  }
  collectBindings(source);
  const calls: ModuleMock[] = [];
  function visit(node: ts.Node, cleanup: boolean) {
    if (ts.isCallExpression(node)) {
      const callee = expression(node.expression);
      const property = member(callee);
      const hook = ts.isIdentifier(callee) ? cleanupHooks.has(callee.text)
        : property && ts.isIdentifier(property.object) && namespaces.has(property.object.text)
          && (property.name === 'afterAll' || property.name === 'afterEach');
      if (isModule(callee) || (ts.isIdentifier(callee) && moduleAliases.has(callee.text))) {
        const target = node.arguments[0];
        calls.push({ call: node, module: target && ts.isStringLiteralLike(target) ? target.text : null,
          result: factoryResult(node.arguments[1]), cleanup });
      }
      if (hook) {
        for (const argument of node.arguments) visit(argument, true);
        return;
      }
    }
    ts.forEachChild(node, child => visit(child, cleanup));
  }
  visit(source, false);
  // Follow literal imports and their snapshots, never an arbitrary spread.
  function original(node: ts.Expression, module: string, seen = new Set<string>()): boolean {
    node = expression(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = node.arguments[0];
      const firstMock = calls.find(call => call.module === module)?.call.getStart(source) ?? Infinity;
      return !!target && ts.isStringLiteralLike(target) && target.text === module
        && node.getStart(source) < firstMock;
    }
    if (ts.isIdentifier(node)) {
      if (imports.get(node.text) === module) return true;
      if (seen.has(node.text)) return false;
      seen.add(node.text);
      const binding = bindings.get(node.text);
      return !!binding?.initializer && original(binding.initializer, module, seen);
    }
    return ts.isObjectLiteralExpression(node) && node.properties.length === 1
      && ts.isSpreadAssignment(node.properties[0]!) && original(node.properties[0]!.expression, module, seen);
  }
  const violations: string[] = [];
  for (const call of calls) {
    const result = call.result;
    const preserved = call.module && result && (original(result, call.module)
      || (ts.isObjectLiteralExpression(result) && result.properties.some(property =>
        ts.isSpreadAssignment(property) && original(property.expression, call.module!))));
    const restored = call.module && calls.some(other => other.module === call.module && other.cleanup
      && other.result && original(other.result, call.module!));
    if (preserved || restored) continue;
    const line = source.getLineAndCharacterOfPosition(call.call.getStart(source)).line + 1;
    violations.push(`${line}: ${call.module ?? 'dynamic module'} must spread its real exports or restore them in afterAll/afterEach`);
  }
  return { count: calls.length, violations };
}

function webSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.temp', '.vinext', '.next'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? webSources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test('every web module mock preserves real exports or restores them after its tests', () => {
  const root = join(import.meta.dir, '..');
  const violations: string[] = [];
  let count = 0;
  for (const path of webSources(root)) {
    const result = inspectModuleMocks(readFileSync(path, 'utf8'));
    count += result.count;
    violations.push(...result.violations.map(violation => `${relative(root, path)}:${violation}`));
  }
  expect(count).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

test('the guard rejects partial, unrelated and late-captured module replacements', () => {
  const bad = [
    `import { mock } from 'bun:test'; mock.module('next/navigation', () => ({ useRouter() {} }));`,
    `import { mock } from 'bun:test'; const fake = {}; mock.module('next/navigation', () => ({ ...fake, useRouter() {} }));`,
    `import { mock } from 'bun:test'; import * as headers from 'next/headers'; mock.module('next/navigation', () => ({ ...headers }));`,
    `import { mock } from 'bun:test'; mock.module('next/navigation', () => ({ useRouter() {} })); const real = { ...(await import('next/navigation')) };`,
    `import { mock, afterAll } from 'bun:test'; mock.module('next/navigation', () => ({})); afterAll(() => mock.restore());`,
    `import { mock as replace } from 'bun:test'; replace['module']('next/navigation', () => ({}));`,
    `import * as tests from 'bun:test'; tests.mock.module('next/navigation', () => ({}));`,
    `import { mock } from 'bun:test'; const replace = mock.module; replace('next/navigation', () => ({}));`,
    `import { mock } from 'bun:test'; const { module: replace } = mock; replace('next/navigation', () => ({}));`,
    `import { mock } from 'bun:test'; mock.module(target, () => ({}));`,
  ];
  for (const source of bad) expect(inspectModuleMocks(source).violations).toHaveLength(1);
});

test('the guard accepts matching real spreads and explicit cleanup, and ignores text mentions', () => {
  const good = [
    `import { mock } from 'bun:test'; import * as real from 'next/navigation'; mock.module('next/navigation', () => ({ ...real, useRouter() {} }));`,
    `import { mock } from 'bun:test'; const real = { ...(await import('next/navigation')) }; mock.module('next/navigation', () => ({ ...real, useRouter() {} }));`,
    `import { mock, afterAll } from 'bun:test'; const real = { ...(await import('next/navigation')) }; mock.module('next/navigation', () => ({})); afterAll(async () => { await mock.module('next/navigation', () => real); });`,
    `import { mock, afterEach } from 'bun:test'; const real = { ...(await import('next/navigation')) }; mock.module('next/navigation', () => ({})); afterEach(() => mock.module('next/navigation', () => real));`,
    `// mock.module('next/navigation', () => ({}));\nconst text = "mock.module('next/navigation', () => ({}))";`,
  ];
  for (const source of good) expect(inspectModuleMocks(source).violations).toEqual([]);
});
