import { repositoryGlob } from '../lib/repository-files.ts';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-6';

const root = fileURLToPath(new URL('../../', import.meta.url));
type Finding = { file: string; row: string; expression: string };
type Sources = Map<string, ts.SourceFile>;

function parse(file: string, text: string) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function imports(source: ts.SourceFile): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) result.push(node.moduleReference.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function importedFile(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return;
  const path = resolve(root, dirname(file), specifier);
  return [path, path.replace(/\.js$/, '.ts'), `${path}.ts`, `${path}/index.ts`]
    .find(candidate => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
}

function inventory(): { sources: Sources; rows: Map<string, Set<string>> } {
  const sources: Sources = new Map();
  const rows = new Map<string, Set<string>>();
  const load = (file: string) => {
    if (!sources.has(file)) sources.set(file, parse(file, readFileSync(resolve(root, file), 'utf8')));
    return sources.get(file)!;
  };
  for (const file of repositoryGlob(root, 'tests/qa/integration/outcomes/**/*.{ts,tsx,js,mjs,cjs}')) {
    const source = load(file);
    const rowIds = imports(source).flatMap(specifier => {
      const declaration = importedFile(file, specifier);
      if (!declaration || !declaration.includes('/scripts/qa/cases/outcomes/')) return [];
      const ids: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'rowOutcomes'
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) ids.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(parse(declaration, readFileSync(declaration, 'utf8')));
      return ids;
    });
    // Non-row fixture modules are reached again from their importing row.
    for (const row of rowIds) {
      const seen = new Set<string>();
      const walk = (dependency: string) => {
        if (seen.has(dependency)) return;
        seen.add(dependency);
        const owners = rows.get(dependency) ?? new Set<string>();
        owners.add(row); rows.set(dependency, owners);
        for (const specifier of imports(load(dependency))) {
          const path = importedFile(dependency, specifier);
          if (!path) continue;
          const next = relative(root, path);
          if (next.startsWith('tests/qa/')) walk(next);
        }
      };
      walk(file);
    }
  }
  return { sources, rows };
}

function expressions(source: ts.SourceFile, sources: Sources = new Map()): string[] {
  const bindings = new Map<string, ts.Expression>();
  const functions = new Map<string, ts.SignatureDeclaration>();
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) functions.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, index);
  };
  index(source);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const direct = relative(root, resolve(root, dirname(source.fileName), statement.moduleSpecifier.text));
    const path = importedFile(source.fileName, statement.moduleSpecifier.text);
    const imported = sources.get(direct) ?? (path ? sources.get(relative(root, path)) : undefined);
    const names = statement.importClause?.namedBindings;
    if (!imported || !names || !ts.isNamedImports(names)) continue;
    for (const name of names.elements) {
      const declaration = imported.statements.find(item => ts.isFunctionDeclaration(item)
        && item.name?.text === (name.propertyName ?? name.name).text);
      if (declaration && ts.isFunctionDeclaration(declaration)) functions.set(name.name.text, declaration);
      for (const statement of imported.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const binding of statement.declarationList.declarations) {
          if (!ts.isIdentifier(binding.name) || binding.name.text !== (name.propertyName ?? name.name).text || !binding.initializer) continue;
          bindings.set(name.name.text, binding.initializer);
          if (ts.isArrowFunction(binding.initializer) || ts.isFunctionExpression(binding.initializer)) functions.set(name.name.text, binding.initializer);
        }
      }
    }
  }
  const unwrap = (node: ts.Expression): ts.Expression => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node)) return unwrap(node.expression);
    return node;
  };
  const status = (input: ts.Expression, seen = new Set<string>()): boolean => {
    const node = unwrap(input);
    if (ts.isPropertyAccessExpression(node)) return /^(status|statusCode)$/.test(node.name.text);
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression))
      return /^(status|statusCode)$/.test(node.argumentExpression.text);
    if (!ts.isIdentifier(node)) return false;
    if (/^(status|statusCode|expectedStatus|acceptedStatuses|statuses)$/.test(node.text)) return true;
    if (seen.has(node.text)) return false;
    seen.add(node.text);
    const value = bindings.get(node.text);
    return !!value && status(value, seen);
  };
  const faults = (input: ts.Node, seen = new Set<string>()): boolean => {
    if (ts.isNumericLiteral(input)) return Number(input.text) >= 500 && Number(input.text) <= 599;
    if (ts.isIdentifier(input)) {
      if (seen.has(input.text)) return false;
      seen.add(input.text);
      const value = bindings.get(input.text);
      return !!value && faults(value, seen);
    }
    // Only descend value containers, never arbitrary calls (timeouts, ports, counts).
    if (ts.isArrayLiteralExpression(input)) return input.elements.some(item => faults(item, new Set(seen)));
    if (ts.isNewExpression(input) && ts.isIdentifier(input.expression) && input.expression.text === 'Set')
      return input.arguments?.some(item => faults(item, new Set(seen))) ?? false;
    if (ts.isObjectLiteralExpression(input)) return input.properties.some(item => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && /^(status|statusCode)$/.test(item.name.text)
      && faults(item.initializer, new Set(seen)));
    if (ts.isParenthesizedExpression(input) || ts.isAsExpression(input) || ts.isSatisfiesExpression(input)) return faults(input.expression, seen);
    return false;
  };
  const found = new Set<string>();
  const record = (node: ts.Node) => found.add(node.getText(source).replace(/\s+/g, ' ').trim());
  const accepts = (node: ts.Node): boolean => {
    if (ts.isThrowStatement(node) || ts.isContinueStatement(node)) return false;
    if (ts.isReturnStatement(node)) return !node.expression || node.expression.kind !== ts.SyntaxKind.FalseKeyword;
    if (ts.isBreakStatement(node)) return true;
    return ts.isBlock(node) && node.statements.some(accepts);
  };
  const comparison = (node: ts.Expression): boolean => {
    node = unwrap(node);
    if (!ts.isBinaryExpression(node)) return false;
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return comparison(node.left) || comparison(node.right);
    if (![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.LessThanToken].includes(node.operatorToken.kind)) return false;
    const leftStatus = status(node.left);
    const literal = leftStatus ? unwrap(node.right) : unwrap(node.left);
    if (!(leftStatus || status(node.right)) || !ts.isNumericLiteral(literal) || !faults(literal)) return false;
    const boundary = Number(literal.text);
    for (let fault = 500; fault <= 599; fault++) {
      const left = leftStatus ? fault : boundary, right = leftStatus ? boundary : fault;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken: if (left === right) return true; break;
        case ts.SyntaxKind.GreaterThanEqualsToken: if (left >= right) return true; break;
        case ts.SyntaxKind.GreaterThanToken: if (left > right) return true; break;
        case ts.SyntaxKind.LessThanEqualsToken: if (left <= right) return true; break;
        case ts.SyntaxKind.LessThanToken: if (left < right) return true; break;
      }
    }
    return false;
  };
  const acceptedMembership = (node: ts.CallExpression): boolean => {
    let parent: ts.Node = node.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isBinaryExpression(parent)) parent = parent.parent;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return false;
    if (ts.isIfStatement(parent) && parent.expression.getStart() <= node.getStart()
      && parent.expression.end >= node.end) return accepts(parent.thenStatement);
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect') {
      const matcher = parent.parent;
      if (ts.isPropertyAccessExpression(matcher) && matcher.name.text === 'not') return false;
      const assertion = matcher.parent;
      if (ts.isCallExpression(assertion) && assertion.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
    return true;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        let receiver = callee.expression;
        let negative = false;
        while (ts.isPropertyAccessExpression(receiver)) {
          if (receiver.name.text === 'not') negative = true;
          receiver = receiver.expression;
        }
        if (!negative && ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)
          && receiver.expression.text === 'expect' && receiver.arguments[0]) {
          const actual = receiver.arguments[0];
          const matcher = callee.name.text;
          if ((status(actual) && /^(toBe|toEqual|toStrictEqual|toContain|toContainEqual|toBeOneOf|toBeGreaterThanOrEqual|toBeLessThanOrEqual|toMatchObject)$/.test(matcher)
            && node.arguments.some(item => faults(item)))
            || (status(actual) && matcher === 'toBeGreaterThan' && node.arguments.some(item => ts.isNumericLiteral(item) && Number(item.text) >= 500 && Number(item.text) < 599))
            || (/^toContain(Equal)?$/.test(matcher) && faults(actual) && node.arguments.some(item => status(item)))
            || (/^(toEqual|toStrictEqual|toMatchObject)$/.test(matcher) && node.arguments.some(item => ts.isObjectLiteralExpression(item) && faults(item)))
            || (status(actual) && matcher === 'toBeLessThan' && node.arguments.some(item => ts.isNumericLiteral(item) && Number(item.text) > 500 && Number(item.text) <= 599))
            || (comparison(actual) && matcher === 'toBe' && node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword)) record(node);
        }
        if (/^(includes|has)$/.test(callee.name.text) && faults(callee.expression) && node.arguments.some(item => status(item))
          && acceptedMembership(node)) record(node);
      }
      if (ts.isIdentifier(callee)) {
        const helper = functions.get(callee.text);
        helper?.parameters.forEach((parameter, position) => {
          if (!ts.isIdentifier(parameter.name) || !node.arguments[position] || !faults(node.arguments[position])) return;
          const name = parameter.name.text;
          let expectedStatus = /^(?:(?:expected|accepted|http)Status(?:Code)?|status(?:Code)?|statuses|acceptedStatuses)$/i.test(name);
          const usage = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
              const receiver = child.expression.expression;
              if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'expect'
                && receiver.arguments[0] && status(receiver.arguments[0])
                && child.arguments.some(argument => ts.isIdentifier(argument) && argument.text === name)) expectedStatus = true;
            }
            ts.forEachChild(child, usage);
          };
          ts.forEachChild(helper!, usage);
          if (expectedStatus) record(node);
        });
      }
    }
    // A retry continues on a fault or returns only on a non-fault; only a fault branch
    // that accepts/returns/breaks is a finding, while throw and continue reject it.
    if (ts.isIfStatement(node) && comparison(node.expression) && accepts(node.thenStatement)) record(node);
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
      && [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.expression.operatorToken.kind)
      && ((status(node.expression.left) && faults(node.expression.right)) || (status(node.expression.right) && faults(node.expression.left)))) {
      const rejects = (branch: ts.Node): boolean => ts.isThrowStatement(branch)
        || (ts.isBlock(branch) && branch.statements.some(item => ts.isThrowStatement(item)));
      if (rejects(node.thenStatement)) record(node);
    }
    if (ts.isCaseClause(node) && faults(node.expression)) {
      const block = node.parent;
      if (ts.isCaseBlock(block) && ts.isSwitchStatement(block.parent) && status(block.parent.expression)) {
        const following = block.clauses.slice(block.clauses.indexOf(node));
        const executed = following.find(clause => clause.statements.length > 0);
        if (executed?.statements.some(accepts)) record(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

test('status expectations detect server faults without mistaking other numbers or retries', () => {
  const bad = [
    'expect(response.status).toBe(503)',
    'expect(response.status).toEqual(500)',
    'expect(response.status).toBeLessThan(503)',
    'expect(response).toMatchObject({status: 503})',
    'expect([200, 503]).toContain(response.status)',
    'const allowed = new Set([200, 599]); allowed.has(response.status)',
    'const allowed = [200, 502]; allowed.includes(response.status)',
    'function denied(persona: string, status: number) {} denied("member", 503)',
    'function answer(response: Response, code: number) { expect(response.status).toBe(code); } answer(response, 503)',
    'expect(response.status === 503).toBe(true)',
    'if (response.status === 503) return response',
    'if (response.status !== 503) throw new Error("wrong status")',
    'switch(response.status) { case 503: break; }',
    'switch(response.status) { case 503: case 200: return response; }',
    'const code = response.status; const fault = 503; expect(code).toStrictEqual(fault)',
  ];
  for (const text of bad) expect(expressions(parse('fixture.ts', text)), text).toHaveLength(1);
  const good = [
    'await Bun.sleep(500); const port = 5432; const count503 = 503; expect(count503).toBe(503)',
    'expect(response.status).toBeLessThan(500); expect(response.status).not.toBe(503)',
    'expect(response.status).toBeGreaterThan(599)',
    'if (response.status >= 500) throw new Error("fault")',
    'for (;;) { if (response.status === 503) { await Bun.sleep(500); continue; } expect(response.status).toBe(200); break; }',
    'if (response.status !== 503) return response; await Bun.sleep(500)',
    'if (response.status < 500) return response; throw new Error("fault")',
    'expect(response.status < 500).toBe(true)',
    'if ([502, 503].includes(response.status)) { await Bun.sleep(500); continue; } expect(response.status).toBe(200)',
    'expect([503].includes(response.status)).toBe(false)',
    'switch(response.status) { case 503: throw new Error("fault"); }',
    'new Response(null, {status: 503})',
    '// expect(response.status).toBe(503)\nconst label = "expect(response.status).toBe(503)";',
  ];
  for (const text of good) expect(expressions(parse('fixture.ts', text)), text).toEqual([]);
});

test('imported helpers and accepted status constants retain their meaning through aliases', () => {
  const file = 'tests/qa/integration/outcomes/fixture.test.ts';
  const helper = 'tests/qa/support/fixture.ts';
  const sources: Sources = new Map([[helper, parse(helper, `
    export function answer(response: Response, code: number) { expect(response.status).toBe(code); }
    export const accepted = new Set([200, 503]);
  `)]]);
  expect(expressions(parse(file, `
    import { answer as check, accepted as allowed } from '../../support/fixture.ts';
    check(response, 503); expect(allowed.has(response.status)).toBe(true);
  `), sources)).toEqual(['allowed.has(response.status)', 'check(response, 503)']);
});

test('outcome proof server fault debt only shrinks', () => {
  const { sources, rows } = inventory();
  const findings: Finding[] = [];
  for (const [file, source] of sources) {
    const expectedFaults = expressions(source, sources);
    const owners = rows.get(file);
    expect(expectedFaults.length === 0 || !!owners?.size,
      `${file}: a server fault expectation must not escape the guard through a missing row declaration`).toBe(true);
    for (const expression of expectedFaults) for (const row of owners ?? []) findings.push({ file, row, expression });
  }
  findings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/static/outcome-expectations.baseline.json'), 'utf8')) as Finding[];
  expect(findings, 'New server fault expectations are forbidden; remove stale baseline entries when repairing a row').toEqual(baseline);
});
