import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript-6';

// These files are claimed by another worker converting their cleanup; this list may only shrink.
const legacyCleanupFiles = [
  'features/work-page/hub-access.test.ts',
  'features/realm-appeal/read.test.ts',
];

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
  if (node.body.statements.length !== 1) return;
  const statement = node.body.statements[0]!;
  return ts.isReturnStatement(statement) && statement.expression ? expression(statement.expression) : undefined;
}

function inspectModuleMocks(text: string, options: { legacy?: boolean; path?: string } = {}): { count: number; violations: string[] } {
  const path = options.path ?? join(import.meta.dir, 'sample.tsx');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mocks = new Set<string>();
  const namespaces = new Set<string>();
  const cleanupHooks = new Set<string>();
  const helpers = new Set<string>();
  const helperNamespaces = new Set<string>();
  const imports = new Map<string, string>();
  const bindings = new Map<string, ts.VariableDeclaration>();
  const functions = new Map<string, ts.Node>();
  const moduleAliases = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      imports.set(named.name.text, module);
      if (module === 'bun:test') namespaces.add(named.name.text);
      if (resolve(dirname(path), module) === join(import.meta.dir, 'support/module-replacement.ts')) {
        helperNamespaces.add(named.name.text);
      }
    } else if (named && ts.isNamedImports(named)) {
      for (const specifier of named.elements) {
        const name = specifier.propertyName?.text ?? specifier.name.text;
        if (module === 'bun:test') {
          if (name === 'mock') mocks.add(specifier.name.text);
          if (name === 'afterAll' || name === 'afterEach') cleanupHooks.add(specifier.name.text);
        }
        if (name === 'replaceModule' && resolve(dirname(path), module) === join(import.meta.dir, 'support/module-replacement.ts')) {
          helpers.add(specifier.name.text);
        }
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
  const isHook = (node: ts.Expression): boolean => {
    node = expression(node);
    if (ts.isIdentifier(node)) return cleanupHooks.has(node.text);
    const property = member(node);
    return !!property && ts.isIdentifier(property.object) && namespaces.has(property.object.text)
      && (property.name === 'afterAll' || property.name === 'afterEach');
  };
  const isHelperFunction = (node: ts.Expression): boolean => {
    node = expression(node);
    if (ts.isIdentifier(node)) return helpers.has(node.text);
    const property = member(node);
    return property?.name === 'replaceModule' && ts.isIdentifier(property.object) && helperNamespaces.has(property.object.text);
  };
  function collectBindings(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initial = expression(node.initializer);
      if (ts.isIdentifier(node.name)) {
        bindings.set(node.name.text, node);
        if (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) functions.set(node.name.text, initial.body);
      }
    }
    ts.forEachChild(node, collectBindings);
  }
  collectBindings(source);
  // Alias chains can hide either the module operation or the cleanup hook.
  for (let pass = 0; pass <= bindings.size; pass++) {
    const size = mocks.size + moduleAliases.size + cleanupHooks.size + helpers.size;
    for (const [name, binding] of bindings) {
      const initial = expression(binding.initializer!);
      if (isMock(initial)) mocks.add(name);
      if (isModule(initial) || (ts.isIdentifier(initial) && moduleAliases.has(initial.text))) moduleAliases.add(name);
      if (isHook(initial)) cleanupHooks.add(name);
      if (isHelperFunction(initial)) helpers.add(name);
    }
    if (size === mocks.size + moduleAliases.size + cleanupHooks.size + helpers.size) break;
  }
  function collectDestructured(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isMock(node.initializer)) {
      for (const binding of node.name.elements) {
        if ((binding.propertyName?.getText(source) ?? binding.name.getText(source)) === 'module'
          && ts.isIdentifier(binding.name)) moduleAliases.add(binding.name.text);
      }
    }
    ts.forEachChild(node, collectDestructured);
  }
  collectDestructured(source);
  const allCalls: ts.CallExpression[] = [];
  function collectCalls(node: ts.Node) {
    if (ts.isCallExpression(node)) allCalls.push(node);
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(source);
  const cleanupCalls = new Set<ts.CallExpression>();
  const cleanupReferences = new Set<string>();
  function followCleanup(node: ts.Node, seen: Set<string>) {
    if (ts.isIdentifier(node)) {
      cleanupReferences.add(node.text);
      if (seen.has(node.text)) return;
      seen.add(node.text);
      const body = functions.get(node.text);
      if (body) followCleanup(body, seen);
      const initial = bindings.get(node.text)?.initializer;
      if (initial && ts.isIdentifier(expression(initial))) followCleanup(expression(initial), seen);
    }
    if (ts.isCallExpression(node)) {
      cleanupCalls.add(node);
      followCleanup(node.expression, seen);
    }
    ts.forEachChild(node, child => followCleanup(child, seen));
  }
  for (const call of allCalls) if (isHook(call.expression)) {
    for (const argument of call.arguments) followCleanup(argument, new Set());
  }
  const isDirect = (call: ts.CallExpression) => isModule(call.expression)
    || (ts.isIdentifier(expression(call.expression)) && moduleAliases.has(expression(call.expression).getText(source)));
  const isHelper = (call: ts.CallExpression) => isHelperFunction(call.expression);
  const calls = allCalls.filter(call => isDirect(call) || isHelper(call));
  function moduleOf(call: ts.CallExpression): string | null {
    let target = call.arguments[0];
    if (isHelper(call)) {
      if (!target || !ts.isCallExpression(target) || target.expression.getText(source) !== 'import.meta.resolve') return null;
      target = target.arguments[0];
    }
    return target && ts.isStringLiteralLike(target) ? target.text : null;
  }
  function original(node: ts.Expression, module: string, before: number, seen = new Set<string>()): boolean {
    node = expression(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = node.arguments[0];
      return !!target && ts.isStringLiteralLike(target) && target.text === module && node.getStart(source) < before;
    }
    if (ts.isIdentifier(node)) {
      if (imports.get(node.text) === module) return true;
      if (seen.has(node.text)) return false;
      seen.add(node.text);
      const binding = bindings.get(node.text);
      return !!binding?.initializer && binding.getStart(source) < before && original(binding.initializer, module, before, seen);
    }
    return ts.isObjectLiteralExpression(node) && node.properties.length === 1
      && ts.isSpreadAssignment(node.properties[0]!) && original(node.properties[0]!.expression, module, before, seen);
  }
  function snapshot(node: ts.Expression, module: string, before: number, seen = new Set<string>()): boolean {
    node = expression(node);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      seen.add(node.text);
      const binding = bindings.get(node.text);
      return !!binding?.initializer && binding.getStart(source) < before && snapshot(binding.initializer, module, before, seen);
    }
    return ts.isObjectLiteralExpression(node) && node.properties.length === 1
      && ts.isSpreadAssignment(node.properties[0]!) && original(node.properties[0]!.expression, module, before);
  }
  function topLevel(node: ts.Node): boolean {
    const binding = node.parent;
    return ts.isVariableDeclaration(binding) && ts.isVariableDeclarationList(binding.parent)
      && ts.isVariableStatement(binding.parent.parent) && ts.isSourceFile(binding.parent.parent.parent);
  }
  const violations: string[] = [];
  const installed = new Set<string>();
  for (const call of calls) {
    const module = moduleOf(call);
    const before = calls.find(other => moduleOf(other) === module)?.getStart(source) ?? call.getStart(source);
    const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
    const fail = (reason: string) => violations.push(`${line}: ${module ?? 'dynamic module'} ${reason}`);
    if (isDirect(call)) {
      if (!options.legacy) {
        fail(cleanupCalls.has(call) ? 'must never call mock.module from cleanup, including called functions'
          : 'must use replaceModule at file top level');
        continue;
      }
      const result = factoryResult(call.arguments[1]);
      const preserved = module && result && (snapshot(result, module, before)
        || (ts.isObjectLiteralExpression(result) && result.properties.some(property =>
          ts.isSpreadAssignment(property) && original(property.expression, module, before))));
      const restored = module && calls.some(other => moduleOf(other) === module && cleanupCalls.has(other)
        && factoryResult(other.arguments[1]) && snapshot(factoryResult(other.arguments[1])!, module, before));
      if (!preserved && !restored) fail('must preserve its real exports');
      continue;
    }
    if (!topLevel(call) || cleanupCalls.has(call)) fail('must install replaceModule once at file top level');
    if (!module || installed.has(module)) fail('must resolve one literal module and install it only once');
    if (module) installed.add(module);
    if (!module || !call.arguments[1] || !snapshot(call.arguments[1], module, before)) fail('must pass a snapshot of every real export before replacement');
    const binding = call.parent;
    if (!ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name) || !cleanupReferences.has(binding.name.text)) {
      fail('must register its returned cleanup with afterAll/afterEach');
    }
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

test('every web module replacement uses a top-level delegate and resets its table', () => {
  const root = join(import.meta.dir, '..');
  const violations: string[] = [];
  let count = 0;
  for (const path of webSources(root)) {
    // This is the single implementation of the guarded operation, covered by its runtime order test.
    if (path === join(import.meta.dir, 'support/module-replacement.ts')) continue;
    const file = relative(root, path);
    const result = inspectModuleMocks(readFileSync(path, 'utf8'), { path, legacy: legacyCleanupFiles.includes(file) });
    count += result.count;
    violations.push(...result.violations.map(violation => `${file}:${violation}`));
  }
  expect(count).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

const helperImport = `import { replaceModule } from './support/module-replacement.ts';`;
const realSnapshot = `const real = { ...(await import('next/navigation')) };`;
const install = `const reset = replaceModule(import.meta.resolve('next/navigation'), real, { useRouter() {} });`;

test('the guard rejects bare replacements, including cleanup through functions and aliases', () => {
  const bad = [
    `import { mock } from 'bun:test'; mock.module('next/navigation', () => ({ useRouter() {} }));`,
    `import { mock } from 'bun:test'; ${realSnapshot} mock.module('next/navigation', () => ({ ...real, useRouter() {} }));`,
    `import { mock as replace, afterAll } from 'bun:test'; ${realSnapshot} afterAll(() => replace['module']('next/navigation', () => real));`,
    `import * as tests from 'bun:test'; ${realSnapshot} tests.afterEach(() => tests.mock.module('next/navigation', () => real));`,
    `import { mock, afterAll } from 'bun:test'; ${realSnapshot} const replace = mock.module; afterAll(() => replace('next/navigation', () => real));`,
    `import { mock, afterAll } from 'bun:test'; ${realSnapshot} const replacement = mock; afterAll(() => replacement.module('next/navigation', () => real));`,
    `import { mock, afterEach } from 'bun:test'; ${realSnapshot} const { module: replace } = mock; afterEach(() => replace('next/navigation', () => real));`,
    `import { mock, afterAll } from 'bun:test'; ${realSnapshot} function restore() { mock.module('next/navigation', () => real); } afterAll(restore);`,
    `import { mock, afterEach } from 'bun:test'; ${realSnapshot} const restore = () => mock.module('next/navigation', () => real); function cleanup() { restore(); } afterEach(() => cleanup());`,
    `import { mock, afterAll as finish } from 'bun:test'; ${realSnapshot} const restore = () => mock.module('next/navigation', () => real); const alias = restore; const hook = finish; hook(alias);`,
  ];
  for (const source of bad) expect(inspectModuleMocks(source).violations).toHaveLength(1);
  for (const source of bad.slice(2)) expect(inspectModuleMocks(source).violations[0]).toContain('never call mock.module from cleanup');
});

test('the guard requires a matching early snapshot, one top-level installation and cleanup', () => {
  const bad = [
    `${helperImport} import { afterAll } from 'bun:test'; const real = {}; ${install} afterAll(reset);`,
    `${helperImport} import { afterAll } from 'bun:test'; const real = { ...(await import('next/headers')) }; ${install} afterAll(reset);`,
    `${helperImport} import { afterAll } from 'bun:test'; const real = await import('next/navigation'); ${install} afterAll(reset);`,
    `${helperImport} import { afterAll } from 'bun:test'; ${install} ${realSnapshot} afterAll(reset);`,
    `${helperImport} ${realSnapshot} ${install}`,
    `${helperImport} import { beforeEach, afterAll } from 'bun:test'; ${realSnapshot} beforeEach(() => { ${install} afterAll(reset); });`,
    `${helperImport} import { afterAll } from 'bun:test'; ${realSnapshot} afterAll(() => { ${install} });`,
    `import * as replacements from './support/module-replacement.ts'; import { afterAll } from 'bun:test'; ${realSnapshot} afterAll(() => replacements.replaceModule(import.meta.resolve('next/navigation'), real, {}));`,
    `${helperImport} import { afterAll } from 'bun:test'; ${realSnapshot} if (true) { ${install} afterAll(reset); }`,
    `${helperImport} import { afterAll } from 'bun:test'; ${realSnapshot} const reset = replaceModule(target, real, {}); afterAll(reset);`,
    `${helperImport} import { afterAll } from 'bun:test'; ${realSnapshot} ${install} const second = replaceModule(import.meta.resolve('next/navigation'), real, {}); afterAll(reset); afterAll(second);`,
  ];
  for (const source of bad) expect(inspectModuleMocks(source).violations.length).toBeGreaterThan(0);
});

test('the guard accepts real snapshots, cleanup callbacks, table changes and text mentions', () => {
  const good = [
    `${helperImport} import { afterAll } from 'bun:test'; ${realSnapshot} ${install} afterAll(reset);`,
    `${helperImport} import { afterEach } from 'bun:test'; ${realSnapshot} ${install} afterEach(() => reset()); reset.set({ useRouter() {} });`,
    `${helperImport} import { afterAll } from 'bun:test'; import * as navigation from 'next/navigation'; const reset = replaceModule(import.meta.resolve('next/navigation'), { ...navigation }, {}); function cleanup() { reset(); } afterAll(cleanup);`,
    `${helperImport} import { afterAll } from 'bun:test'; const original = await import('next/navigation'); const real = { ...original }; ${install} const cleanup = () => reset(); afterAll(cleanup);`,
    `import { replaceModule as replace } from './support/module-replacement.ts'; import { afterAll } from 'bun:test'; ${realSnapshot} const reset = replace(import.meta.resolve('next/navigation'), real, {}); afterAll(reset);`,
    `import * as replacements from './support/module-replacement.ts'; import { afterAll } from 'bun:test'; ${realSnapshot} const reset = replacements.replaceModule(import.meta.resolve('next/navigation'), real, {}); afterAll(reset);`,
    `// mock.module('next/navigation', () => ({}));\nconst text = "mock.module('next/navigation', () => ({}))";`,
  ];
  for (const source of good) expect(inspectModuleMocks(source).violations).toEqual([]);
});

test('legacy exemptions still require real exports and cannot restore a live namespace', () => {
  const good = `import { mock, afterAll } from 'bun:test'; ${realSnapshot} mock.module('next/navigation', () => ({})); afterAll(() => mock.module('next/navigation', () => real));`;
  expect(inspectModuleMocks(good, { legacy: true }).violations).toEqual([]);
  const bad = [
    `import { mock } from 'bun:test'; mock.module('next/navigation', () => ({ useRouter() {} }));`,
    `import { mock } from 'bun:test'; const fake = {}; mock.module('next/navigation', () => ({ ...fake }));`,
    `import { mock } from 'bun:test'; import * as headers from 'next/headers'; mock.module('next/navigation', () => ({ ...headers }));`,
    `import { mock, afterAll } from 'bun:test'; mock.module('next/navigation', () => ({})); ${realSnapshot} afterAll(() => mock.module('next/navigation', () => real));`,
    `import { mock, afterAll } from 'bun:test'; const real = await import('next/navigation'); mock.module('next/navigation', () => ({})); afterAll(() => mock.module('next/navigation', () => real));`,
  ];
  for (const source of bad) expect(inspectModuleMocks(source, { legacy: true }).violations.length).toBeGreaterThan(0);
});
