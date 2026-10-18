import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { expect, test } from 'bun:test';
import ts from 'typescript-6';
import { launchCoverage, type JourneyProof, type Proof } from '../../../scripts/qa/cases/launch-coverage.ts';
import { loadOutcomes, outcomeTitle, personas } from '../../../scripts/qa/cases/outcomes.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const kinds = ['books', 'recipes', 'visual-novels', 'anime', 'manga', 'games', 'realm', 'zone'] as const;
const hardCases = [
  'ambiguous-editions',
  'mixed-formats',
  'non-ui-languages',
  'thousand-chapters',
  'revoked-editors',
  'interrupted-exports',
  'two-device-progress',
  'expired-loans',
] as const;
const missingItems = new Set([
  'L10',
  'L11',
  'L12',
  'L13',
  'L17',
  'L19',
  'L20',
  'L21',
  'L26',
  'gap',
  'content-adoption',
]);
const requiredHardCaseRows = [
  { kind: 'books', hardCase: 'two-device-progress' },
  { kind: 'visual-novels', hardCase: 'two-device-progress' },
  { kind: 'anime', hardCase: 'two-device-progress' },
  { kind: 'manga', hardCase: 'two-device-progress' },
  { kind: 'games', hardCase: 'two-device-progress' },
  { kind: 'books', hardCase: 'thousand-chapters' },
  { kind: 'anime', hardCase: 'thousand-chapters' },
] as const;

function testApiPath(expression: ts.Expression): string[] {
  if (ts.isCallExpression(expression)) return testApiPath(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) return [...testApiPath(expression.expression), expression.name.text];
  return ts.isIdentifier(expression) ? [expression.text] : [];
}

function testCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // Playwright accepts (title, options, fn); Bun accepts (title, fn, timeout).
  // A predicate function in the first argument is not a declaration's body.
  return call.arguments.slice(1).findLast((argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
    ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
}

function isTestDeclaration(call: ts.CallExpression): boolean {
  const [root, ...members] = testApiPath(call.expression);
  const title = call.arguments[0];
  return (root === 'test' || root === 'it') &&
    members.every(member => ['only', 'skip', 'skipIf', 'todo', 'fixme', 'fail', 'failing', 'if', 'each'].includes(member)) &&
    title !== undefined && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title) ||
      ts.isIdentifier(title) || ts.isPropertyAccessExpression(title)) &&
    testCallback(call) !== undefined;
}

function isSuiteDeclaration(call: ts.CallExpression): boolean {
  const path = testApiPath(call.expression);
  return ['test', 'describe'].includes(path[0] ?? '') && path.includes('describe') && testCallback(call) !== undefined;
}

function hasSkipModifier(call: ts.CallExpression): boolean {
  const [root, ...members] = testApiPath(call.expression);
  return ['test', 'it', 'describe'].includes(root ?? '') &&
    members.some(member => ['skip', 'skipIf', 'fixme', 'fail', 'failing', 'todo', 'if'].includes(member));
}

function scopeHasRuntimeSkip(scope: ts.Node): boolean {
  let disabled = false;
  const visit = (node: ts.Node): void => {
    if (disabled) return;
    if (ts.isCallExpression(node)) {
      // Sibling declarations and their hooks belong to their own test or suite.
      if (isTestDeclaration(node) || isSuiteDeclaration(node)) return;
      const path = testApiPath(node.expression);
      if (['test', 'it'].includes(path[0] ?? '') && ['skip', 'fixme', 'fail', 'failing'].includes(path.at(-1) ?? '')) {
        disabled = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return disabled;
}

function isTopLevelRegistration(call: ts.CallExpression): boolean {
  const statement = call.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== call) return false;
  const scope = statement.parent;
  if (ts.isSourceFile(scope)) return true;
  if (!ts.isBlock(scope)) return false;
  const callback = scope.parent;
  if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.body !== scope) return false;
  const suite = callback.parent;
  return ts.isCallExpression(suite) && isSuiteDeclaration(suite) && testCallback(suite) === callback &&
    isTopLevelRegistration(suite);
}

type JourneyRegistrations = Map<string, (ts.ArrayLiteralExpression | undefined)[]>;
type JourneyFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type RegisteredFunctions = Map<JourneyFunction, Map<string, ts.ArrayLiteralExpression | undefined>>;

function unwrapped(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function literalArray(expression: ts.Expression, at: ts.Node, registered: RegisteredFunctions): ts.ArrayLiteralExpression | undefined {
  const value = unwrapped(expression);
  if (ts.isArrayLiteralExpression(value)) return value.elements.length &&
    !value.elements.some(ts.isSpreadElement) ? value : undefined;
  if (!ts.isIdentifier(value)) return undefined;
  for (let scope: ts.Node | undefined = at; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(entry =>
          ts.isIdentifier(entry.name) && entry.name.text === value.text);
        if (declaration) {
          const initial = declaration.initializer && unwrapped(declaration.initializer);
          return (statement.declarationList.flags & ts.NodeFlags.Const) && initial &&
            ts.isArrayLiteralExpression(initial) ? literalArray(initial, declaration, registered) : undefined;
        }
      }
    }
    if (ts.isForOfStatement(scope) && ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some(entry => ts.isIdentifier(entry.name) && entry.name.text === value.text)) return undefined;
    if (ts.isFunctionDeclaration(scope) || ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) {
      const parameter = scope.parameters.find(entry => ts.isIdentifier(entry.name) && entry.name.text === value.text);
      if (parameter) return registered.get(scope)?.get(value.text);
    }
  }
  return undefined;
}

function literalLoop(loop: ts.ForOfStatement, registered: RegisteredFunctions): ts.ArrayLiteralExpression | undefined {
  if (loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer) ||
    loop.initializer.declarations.length !== 1) return undefined;
  return literalArray(loop.expression, loop, registered);
}

function isCollectedStatement(statement: ts.Statement, registered: RegisteredFunctions): boolean {
  const scope = statement.parent;
  if (ts.isSourceFile(scope)) return true;
  if (ts.isForOfStatement(scope)) return literalLoop(scope, registered) !== undefined && isCollectedStatement(scope, registered);
  if (!ts.isBlock(scope)) return false;
  const owner = scope.parent;
  if (ts.isForOfStatement(owner)) return literalLoop(owner, registered) !== undefined && isCollectedStatement(owner, registered);
  if (ts.isFunctionDeclaration(owner) || ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
    if (registered.has(owner)) return true;
    const suite = owner.parent;
    return ts.isCallExpression(suite) && isSuiteDeclaration(suite) && testCallback(suite) === owner &&
      ts.isExpressionStatement(suite.parent) && suite.parent.expression === suite && isCollectedStatement(suite.parent, registered);
  }
  return false;
}

/**
 * Proof validation is syntactic and deliberately conservative, not execution modelling.
 * A cited test or journey registration must be a direct expression statement in the
 * file or a describe callback body, with each enclosing describe registered the same
 * way. Test declarations also count in nonempty literal-array for-of loops in those
 * scopes, and in journey exports proven registered by a direct unskipped wrapper call.
 * Registered journey loop parameters must have literal supplied/default arrays.
 * Conditions, unknown loops, other expressions and unregistered functions never count.
 * A test declaration has a string, template or reference title and an inline function
 * body after that title (with optional Playwright options or a Bun timeout). Skipped
 * sibling declarations have their own scopes and never disqualify another proof.
 * A test.skip/fixme/fail/failing call without such a body is a runtime skip; a first-argument
 * predicate is not a test body. Any runtime skip rejects its enclosing proof, describe
 * or file scope, including hooks, unused helpers and untaken branches. Conditions are
 * never evaluated: test.skip(false) still rejects that scope.
 * Skip/fixme/fail/failing/todo/if/skipIf modifiers (including test.describe.skip) reject all
 * contained tests and journey registrations regardless of their condition's value.
 * The same scope rule applies to direct tests, table registrations and journey wrappers.
 * False rejections are intentional: cited proofs must have scopes free of skip constructs.
 */
function proofScopeIsUnskipped(call: ts.CallExpression, registered: RegisteredFunctions = new Map()): boolean {
  if (isTestDeclaration(call)) {
    if (!ts.isExpressionStatement(call.parent) || call.parent.expression !== call || !isCollectedStatement(call.parent, registered)) return false;
  } else if (!isTopLevelRegistration(call)) return false;
  for (let node: ts.Node | undefined = call; node; node = node.parent) {
    if (ts.isCallExpression(node) && hasSkipModifier(node)) return false;
    if ((ts.isBlock(node) || ts.isSourceFile(node)) && scopeHasRuntimeSkip(node)) return false;
  }
  const callback = testCallback(call);
  return !callback || !scopeHasRuntimeSkip(callback.body);
}

function namedTestExists(source: string, title: string, registrations: JourneyRegistrations = new Map()): boolean {
  if (/^G-?\d+(?::|\s)/.test(title)) return false;
  const parsed = ts.createSourceFile('proof.ts', source, ts.ScriptTarget.Latest, true);
  // Older test titles open with a task tag; the registry keeps the exact title after it.
  const withoutTag = (candidate: string) => candidate.replace(/^G-?\d+(?::\s*|\s+)/, '');
  const escapePattern = (candidate: string) => candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = (candidate: ts.Expression): boolean => {
    if (ts.isStringLiteralLike(candidate)) return withoutTag(candidate.text) === title;
    if (!ts.isTemplateExpression(candidate)) return false;
    if (withoutTag(candidate.getText(parsed).slice(1, -1)) === title) return true;
    const pattern = escapePattern(withoutTag(candidate.head.text)) +
      candidate.templateSpans.map(span => `.+?${escapePattern(span.literal.text)}`).join('');
    return new RegExp(`^${pattern}$`).test(title);
  };
  const registered: RegisteredFunctions = new Map();
  for (const statement of parsed.statements) {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const functions: [string, JourneyFunction][] = [];
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) functions.push([statement.name.text, statement]);
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const entry of statement.declarationList.declarations) {
        if (ts.isIdentifier(entry.name) && entry.initializer && (ts.isArrowFunction(entry.initializer) || ts.isFunctionExpression(entry.initializer))) {
          functions.push([entry.name.text, entry.initializer]);
        }
      }
    }
    for (const [name, fn] of functions) {
      const argumentsForCall = registrations.get(name);
      if (!argumentsForCall) continue;
      const parameters = new Map<string, ts.ArrayLiteralExpression | undefined>();
      fn.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const initial = parameter.initializer && unwrapped(parameter.initializer);
        parameters.set(parameter.name.text, index < argumentsForCall.length ? argumentsForCall[index]
          : initial && ts.isArrayLiteralExpression(initial) ? literalArray(initial, fn, registered) : undefined);
      });
      registered.set(fn, parameters);
    }
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestDeclaration(node)) {
      const argument = node.arguments[0];
      if (!argument || !proofScopeIsUnskipped(node, registered)) return;
      if (matches(argument)) found = true;
      if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && argument.name.text === 'title') {
        for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
          if (!ts.isForOfStatement(ancestor) || !ts.isVariableDeclarationList(ancestor.initializer)) continue;
          const binding = ancestor.initializer.declarations[0]?.name;
          if (!binding || !ts.isIdentifier(binding) || binding.text !== argument.expression.text) continue;
          for (const entry of literalLoop(ancestor, registered)?.elements ?? []) {
            if (!ts.isObjectLiteralExpression(entry) || entry.properties.some(property => ts.isSpreadAssignment(property) ||
              (property.name && ts.isComputedPropertyName(property.name)))) continue;
            const titles = entry.properties.filter(property => property.name &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'title');
            if (titles.length === 1 && titles[0] && ts.isPropertyAssignment(titles[0]) && matches(titles[0].initializer)) found = true;
          }
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function proofMissing(proof: Proof): proof is Extract<Proof, { missing: string }> {
  return 'missing' in proof;
}

function journeyProof(proof: Proof): proof is JourneyProof {
  return 'journey' in proof;
}

function journeyRegistrations(wrapper: string, moduleSpecifier: string): JourneyRegistrations {
  const parsed = ts.createSourceFile('wrapper.ts', wrapper, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) imports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
    }
  }
  const registrations: JourneyRegistrations = new Map();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      imports.has(node.expression.text) && proofScopeIsUnskipped(node)) {
      registrations.set(imports.get(node.expression.text)!, node.arguments.map(argument => literalArray(argument, node, new Map())));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return registrations;
}

function journeyRegistered(wrapper: string, moduleSpecifier: string): boolean {
  return journeyRegistrations(wrapper, moduleSpecifier).size > 0;
}

function registrationPlacementFixtures(call: string): { source: string; accepted: boolean }[] {
  const statement = `${call};`;
  return [
    { source: statement, accepted: true },
    { source: `describe('suite', () => { ${statement} });`, accepted: true },
    { source: `test.describe('suite', function () { ${statement} });`, accepted: true },
    { source: `describe('outer', () => { describe('inner', () => { ${statement} }); });`, accepted: true },
    { source: `if (false) { ${statement} }`, accepted: false },
    { source: `if (true) { ${statement} }`, accepted: false },
    { source: `enabled ? ${call} : undefined;`, accepted: false },
    { source: `false && ${call};`, accepted: false },
    { source: `true && ${call};`, accepted: false },
    { source: `enabled || ${call};`, accepted: false },
    { source: `maybe ?? ${call};`, accepted: false },
    { source: `(${call});`, accepted: false },
    { source: `void ${call};`, accepted: false },
    { source: `const registered = ${call};`, accepted: false },
    { source: `consume(${call});`, accepted: false },
    { source: `function unused() { ${statement} }`, accepted: false },
    { source: `const unused = () => { ${statement} };`, accepted: false },
    { source: `(() => { ${statement} })();`, accepted: false },
    { source: `test('another test', () => { ${statement} });`, accepted: false },
    { source: `function unused() { describe('suite', () => { ${statement} }); }`, accepted: false },
    { source: `if (false) { describe('suite', () => { ${statement} }); }`, accepted: false },
    { source: `describe('suite', () => { if (true) { ${statement} } });`, accepted: false },
    { source: `for (const item of items) { ${statement} }`, accepted: false },
    { source: `{ ${statement} }`, accepted: false },
  ];
}

function rowLabel(row: (typeof launchCoverage)[number]): string {
  return `${row.kind} / ${row.capability}${row.hardCase ? ` (${row.hardCase})` : ''}`;
}

function missingForRow(row: (typeof launchCoverage)[number]): string[] {
  return [row.api, row.browser]
    .filter(proofMissing)
    .map((proof) => proof.missing);
}

function missingSlots(row: (typeof launchCoverage)[number]): string[] {
  const label = (tier: string, proof: Extract<Proof, { missing: string }>) =>
    `${tier} ${proof.missing}${proof.reason ? ` (${proof.reason})` : ''}`;
  return [
    ...(proofMissing(row.api) ? [label('API', row.api)] : []),
    ...(proofMissing(row.browser) ? [label('browser', row.browser)] : []),
  ];
}

test('launch coverage names existing tests and reports remaining rows', async () => {
  const outcomes = await loadOutcomes({ root: repositoryRoot });
  const outcomeProofs = new Set([...outcomes.values()].flatMap(declaration => personas.flatMap(persona => {
    const cell = declaration.cells[persona];
    return cell?.state === 'proved' ? [JSON.stringify([cell.file, outcomeTitle(declaration, persona)])] : [];
  })));
  const errors: string[] = [];
  const provedPairs = launchCoverage.filter((row) => !proofMissing(row.api) && !proofMissing(row.browser));
  const missingRows = launchCoverage.filter((row) => proofMissing(row.api) || proofMissing(row.browser));
  const missingCounts = new Map([...missingItems].map((item) => [item, 0]));

  for (const row of launchCoverage) {
    if (!proofMissing(row.api) &&
      !/^(?:tests\/qa\/integration\/|services\/[^/]+\/tests\/).+\.test\.ts$/.test(row.api.file)) {
      errors.push(`${rowLabel(row)}: API proof must name an integration test file: ${row.api.file}`);
    }
    if (!proofMissing(row.browser) &&
      (!row.browser.file.startsWith('apps/web/tests/') || !row.browser.file.endsWith('.e2e.ts'))) {
      errors.push(`${rowLabel(row)}: browser proof must name an apps/web/tests/*.e2e.ts file: ${row.browser.file}`);
    }

    for (const proof of [row.api, row.browser]) {
      if (proofMissing(proof)) {
        if (!missingItems.has(proof.missing)) errors.push(`${rowLabel(row)}: unknown missing item ${proof.missing}`);
        if (proof.reason !== undefined && (!proof.reason.trim() || /[\r\n]/.test(proof.reason))) {
          errors.push(`${rowLabel(row)}: missing reason must be one nonempty line`);
        }
        continue;
      }

      if (/^G-?\d+(?::|\s)/.test(proof.test)) {
        errors.push(`${rowLabel(row)}: test title must omit its leading task tag`);
      }
      if (proof.evidence !== undefined && (!proof.evidence.trim() || /[\r\n]/.test(proof.evidence))) {
        errors.push(`${rowLabel(row)}: evidence must be one nonempty line`);
      }

      const filePath = resolve(repositoryRoot, proof.file);
      if (!existsSync(filePath)) {
        errors.push(`${rowLabel(row)}: missing file ${proof.file}`);
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      if (journeyProof(proof)) {
        const journeyPath = resolve(repositoryRoot, proof.journey);
        if (!existsSync(journeyPath)) {
          errors.push(`${rowLabel(row)}: missing journey module ${proof.journey}`);
          continue;
        }
        const moduleSpecifier = relative(dirname(proof.file), proof.journey).split(sep).join('/');
        const relativeModule = moduleSpecifier.startsWith('.') ? moduleSpecifier : `./${moduleSpecifier}`;
        const registrations = journeyRegistrations(source, relativeModule);
        if (!registrations.size) {
          errors.push(`${rowLabel(row)}: ${proof.file} does not register ${proof.journey}`);
        }
        const journeySource = readFileSync(journeyPath, 'utf8');
        if (!namedTestExists(journeySource, proof.test, registrations)) {
          errors.push(`${rowLabel(row)}: unskipped test declaration not found in journey ${proof.journey}: ${proof.test}`);
        }
      } else if (!namedTestExists(source, proof.test) && !outcomeProofs.has(JSON.stringify([proof.file, proof.test]))) {
        errors.push(`${rowLabel(row)}: unskipped test declaration not found in ${proof.file}: ${proof.test}`);
      }
    }

    for (const item of new Set(missingForRow(row))) {
      missingCounts.set(item, (missingCounts.get(item) ?? 0) + 1);
    }
  }

  const remaining = missingRows.length
    ? missingRows.map((row) => `- ${rowLabel(row)}: ${missingSlots(row).join('; ')}`).join('\n')
    : '- none';
  const byItem = [...missingCounts.entries()].sort(([left], [right]) => left.localeCompare(right));
  console.log(
    `Launch coverage: ${launchCoverage.length} rows; ${provedPairs.length} proved pairs; ${missingRows.length} rows still missing.\n` +
      `Missing rows per item: ${byItem.map(([item, count]) => `${item} ${count}`).join(', ') || 'none'}\n` +
      remaining,
  );

  expect(errors, errors.join('\n')).toEqual([]);
});

test('proof titles preserve the exact title after a leading task tag', () => {
  // A sample legacy tag built from a number, so the registry's own test copies no task identifier.
  const sample = 123;
  for (const tag of [`G${sample}: `, `G-${sample}: `, `G${sample} `, `G-${sample} `]) {
    const source = 'test(`' + tag + '${viewport.width}: choose the last chapter`, async () => {});';
    expect(namedTestExists(source, '${viewport.width}: choose the last chapter')).toBe(true);
    expect(namedTestExists(source, 'choose the last chapter')).toBe(false);
    expect(namedTestExists(source, tag + '${viewport.width}: choose the last chapter')).toBe(false);
  }
  expect(namedTestExists("test('a reader saves a choice', () => {});", 'a reader saves a choice')).toBe(true);
});

test('proof scopes distinguish declarations from runtime skips', () => {
  const title = 'a reader resumes on another device';
  const declaration = `test('${title}', () => {});`;
  const fixtures = [
    { source: declaration, accepted: true },
    { source: `test('${title}', function () {});`, accepted: true },
    { source: `test('${title}', { tag: '@launch' }, () => {});`, accepted: true },
    { source: `test('${title}', () => {}, 180_000);`, accepted: true },
    { source: `test.skip('${title}', () => {});`, accepted: false },
    { source: `test.fixme('${title}', () => {});`, accepted: false },
    { source: `test.todo('${title}', () => {});`, accepted: false },
    { source: `test.failing('${title}', () => {});`, accepted: false },
    { source: `test.if(true)('${title}', () => {});`, accepted: false },
    { source: `test.skipIf(false)('${title}', () => {});`, accepted: false },
    { source: `test.skip('another test', () => {}); ${declaration}`, accepted: true },
    { source: `test.fixme('another test', () => { test.skip(); }); ${declaration}`, accepted: true },
    { source: `test.skip('another test', { tag: '@launch' }, () => {}); ${declaration}`, accepted: true },
    { source: `test.skip(otherTitle, () => {}); ${declaration}`, accepted: true },
    { source: `test.skip(otherTitle, function () {}); ${declaration}`, accepted: true },
    { source: `test.fixme(otherTitle, () => { test.fail(); }); ${declaration}`, accepted: true },
    { source: `test.failing(otherTitle, () => { test.fail(); }); ${declaration}`, accepted: true },
    { source: 'test.skip(`another ${device}`, () => {}); ' + declaration, accepted: true },
    { source: `test.skip(other.title, () => {}); ${declaration}`, accepted: true },
    { source: `test('another test', () => { test.skip(); }); ${declaration}`, accepted: true },
    { source: `describe.skip('another suite', () => { beforeEach(() => { test.skip(); }); }); ${declaration}`, accepted: true },
    { source: `describe('another suite', () => { test.beforeEach(() => { test.skip(); }); }); ${declaration}`, accepted: true },
    { source: `// ${declaration}`, accepted: false },
    { source: `const example = ${JSON.stringify(declaration)};`, accepted: false },
    { source: `test('${title}');`, accepted: false },
  ];
  for (const { source, accepted } of fixtures) expect(namedTestExists(source, title), source).toBe(accepted);

  for (const modifier of ['skip', 'fixme', 'fail']) {
    for (const argument of ['', 'true', 'false', 'disabled', '() => true', 'function () { return false; }',
      '({ browserName }) => browserName === "webkit"']) {
      const skip = `test.${modifier}(${argument});`;
      const scopes = [
        `${skip} ${declaration}`,
        `test('${title}', () => { ${skip} });`,
        `test('${title}', { tag: '@launch' }, () => { ${skip} });`,
        `test('${title}', () => { ${skip} }, 180_000);`,
        `describe('suite', () => { ${skip} ${declaration} });`,
        `test.beforeEach(() => { ${skip} }); ${declaration}`,
        `beforeEach(() => { ${skip} }); ${declaration}`,
        `test.beforeAll(() => { ${skip} }); ${declaration}`,
        `describe('outer', () => { beforeEach(() => { ${skip} }); describe('inner', () => { ${declaration} }); });`,
        `function unused() { ${skip} } ${declaration}`,
        `const unused = () => { ${skip} }; ${declaration}`,
        `test('${title}', () => { function unused() { ${skip} } });`,
        `function hook() { ${skip} } beforeEach(hook); ${declaration}`,
        `if (false) { ${skip} } ${declaration}`,
        `test('${title}', () => { if (false) { ${skip} } });`,
        `test.beforeEach(() => { if (false) { ${skip} } }); ${declaration}`,
        `false && test.${modifier}(${argument}); ${declaration}`,
        `true || test.${modifier}(${argument}); ${declaration}`,
        `test('${title}', () => { step(() => { ${skip} }); });`,
      ];
      for (const source of scopes) expect(namedTestExists(source, title), source).toBe(false);
    }
  }
});

test('suite skip constructs reject contained proofs without evaluating conditions', () => {
  const title = 'a reader resumes on another device';
  const declaration = `test('${title}', () => {});`;
  for (const suite of [
    'describe.skip', 'describe.fixme', 'describe.todo',
    'describe.if(true)', 'describe.if(false)', 'describe.if(enabled)',
    'describe.skipIf(false)', 'describe.skipIf(enabled)',
    'test.describe.skip', 'test.describe.fixme',
  ]) {
    const source = `${suite}('suite', () => { ${declaration} });`;
    expect(namedTestExists(source, title), source).toBe(false);
    expect(namedTestExists(`describe('outer', () => { ${source} });`, title), source).toBe(false);
    expect(namedTestExists(`${suite}('another suite', () => {}); ${declaration}`, title), suite).toBe(true);
  }
  expect(namedTestExists(`describe('suite', () => { ${declaration} });`, title)).toBe(true);
});

test('journey registrations follow the same syntactic scope rule', () => {
  const moduleSpecifier = './journeys/reading.ts';
  const imported = `import { registerReadingJourney as register } from '${moduleSpecifier}';`;
  const fixtures = [
    { source: 'register();', accepted: true },
    { source: `describe('suite', () => { register(); });`, accepted: true },
    { source: `describe.skip('suite', () => { register(); });`, accepted: false },
    { source: `describe.fixme('suite', () => { register(); });`, accepted: false },
    { source: `describe.todo('suite', () => { register(); });`, accepted: false },
    { source: `describe.if(false)('suite', () => { register(); });`, accepted: false },
    { source: `describe.if(true)('suite', () => { register(); });`, accepted: false },
    { source: `describe.if(enabled)('suite', () => { register(); });`, accepted: false },
    { source: `test.describe.skip('suite', () => { register(); });`, accepted: false },
    { source: `test.describe.fixme('suite', () => { register(); });`, accepted: false },
    { source: `describe.skipIf(disabled)('suite', () => { register(); });`, accepted: false },
    { source: `describe.skipIf(false)('suite', () => { register(); });`, accepted: false },
    { source: `describe.skip('another suite', () => {}); register();`, accepted: true },
    { source: `test.skip(otherTitle, () => {}); register();`, accepted: true },
    { source: `test.fixme(otherTitle, () => {}); register();`, accepted: true },
    { source: `test('another test', () => { test.skip(true); }); register();`, accepted: true },
    { source: '// register();', accepted: false },
    { source: `const example = 'register();';`, accepted: false },
  ];
  for (const { source, accepted } of fixtures) {
    expect(journeyRegistered(`${imported}\n${source}`, moduleSpecifier), source).toBe(accepted);
  }
  for (const modifier of ['skip', 'fixme', 'fail']) {
    for (const argument of ['', 'false', '() => true']) {
      const skip = `test.${modifier}(${argument});`;
      for (const source of [
        `${skip} register();`,
        `test.beforeEach(() => { ${skip} }); register();`,
        `describe('suite', () => { test.beforeEach(() => { ${skip} }); register(); });`,
        `function unused() { ${skip} } register();`,
        `if (false) { ${skip} } register();`,
      ]) expect(journeyRegistered(`${imported}\n${source}`, moduleSpecifier), source).toBe(false);
    }
  }
  expect(journeyRegistered(imported, moduleSpecifier)).toBe(false);
  expect(journeyRegistered(`${imported} register();`, './journeys/other.ts')).toBe(false);
  expect(journeyRegistered(`import type { register } from '${moduleSpecifier}'; register();`, moduleSpecifier)).toBe(false);
});

test('proof registrations must be direct file or describe statements', () => {
  const title = 'a reader resumes on another device';
  for (const { source, accepted } of registrationPlacementFixtures(`test('${title}', () => {})`)) {
    expect(namedTestExists(source, title), source).toBe(accepted);
  }
  const imported = "import { register } from './journeys/reading.ts';";
  for (const { source, accepted } of registrationPlacementFixtures('register()')) {
    expect(journeyRegistered(`${imported}\n${source}`, './journeys/reading.ts'), source).toBe(accepted);
  }
});

test('literal-array loops collect exact and patterned proof titles', () => {
  const title = 'a reader resumes on another device';
  const call = `test('${title}', () => {});`;
  for (const source of [
    `for (const device of ['phone', 'desktop']) { ${call} }`,
    `const devices = ['phone', 'desktop'] as const; for (const device of devices) ${call}`,
    `describe('suite', () => { const devices = ['phone', 'desktop']; for (const device of devices) { ${call} } });`,
    `const devices = ['phone', 'desktop']; for (const locale of ['en', 'ja']) for (const device of devices) { describe('suite', () => { ${call} }); }`,
  ]) expect(namedTestExists(source, title), source).toBe(true);
  for (const source of [
    `for (const device of unknownDevices) { ${call} }`,
    `const devices = loadDevices(); for (const device of devices) { ${call} }`,
    `let devices = ['phone']; for (const device of devices) { ${call} }`,
    `const devices = []; for (const device of devices) { ${call} }`,
    `const devices = [...otherDevices]; for (const device of devices) { ${call} }`,
    `const devices = ['phone']; describe('suite', () => { let devices = loadDevices(); for (const device of devices) { ${call} } });`,
    `if (true) { for (const device of ['phone']) { ${call} } }`,
    `function unused() { for (const device of ['phone']) { ${call} } }`,
    `for (const device of ['phone']) { if (true) { ${call} } }`,
    `for (const device of ['phone']) { test.skip(false); ${call} }`,
    `for (const device of ['phone']) { describe.skip('suite', () => { ${call} }); }`,
  ]) expect(namedTestExists(source, title), source).toBe(false);

  const patterned = "const devices = ['phone', 'desktop']; for (const device of devices) test(`${device}: choose the last chapter`, () => {});";
  expect(namedTestExists(patterned, '${device}: choose the last chapter')).toBe(true);
  expect(namedTestExists(patterned, 'phone: choose the last chapter')).toBe(true);
  expect(namedTestExists(patterned, 'choose the last chapter')).toBe(false);

  const table = "const journeys = [{ title: 'a reader chooses a format' }, { title: 'another journey' }];";
  for (const registration of [
    'for (const journey of journeys) test(journey.title, () => {});',
    'for (const journey of journeys) { test(journey.title, () => {}); }',
  ]) {
    expect(namedTestExists(`${table} ${registration}`, 'a reader chooses a format')).toBe(true);
    expect(namedTestExists(`describe('suite', () => { ${table} ${registration} });`, 'a reader chooses a format')).toBe(true);
    expect(namedTestExists(`${table} ${registration}`, 'an unused journey')).toBe(false);
    expect(namedTestExists(`${table} ${registration.replace('journey.title', 'journey.label')}`, 'a reader chooses a format')).toBe(false);
  }
  expect(namedTestExists(`${table} journeys.forEach(journey => test(journey.title, () => {}));`, 'a reader chooses a format')).toBe(false);
  expect(namedTestExists("const journeys = [{ title: 'a reader chooses a format', title: 'another' }]; for (const journey of journeys) test(journey.title, () => {});", 'a reader chooses a format')).toBe(false);
});

test('only the journey export registered by an eligible wrapper collects its tests', () => {
  const specifier = './journeys/reading.ts';
  const title = 'a reader resumes on another device';
  const imported = `import { registerReading as register } from '${specifier}';`;
  const journey = `export function registerReading(devices = ['phone', 'desktop']) {
    test('${title}', () => {});
    for (const device of devices) test(\`${'${device}'}: choose the last chapter\`, () => {});
  }
  export function unusedJourney() { test('an unused journey', () => {}); }`;
  const registered = journeyRegistrations(`${imported} register();`, specifier);
  expect(namedTestExists(journey, title, registered)).toBe(true);
  expect(namedTestExists(journey, 'phone: choose the last chapter', registered)).toBe(true);
  expect(namedTestExists(journey, 'an unused journey', registered)).toBe(false);
  expect(namedTestExists(journey, title)).toBe(false);
  expect(namedTestExists(journey.replace('export function registerReading', 'function registerReading'), title, registered)).toBe(false);
  expect(namedTestExists(`export const registerReading = () => { test('${title}', () => {}); };`, title, registered)).toBe(true);
  for (const { source, accepted } of registrationPlacementFixtures('register()')) {
    const registrations = journeyRegistrations(`${imported} ${source}`, specifier);
    expect(namedTestExists(journey, title, registrations), source).toBe(accepted);
  }
  for (const source of [
    `describe.skip('suite', () => { register(); });`,
    `test.beforeEach(() => { test.skip(false); }); register();`,
  ]) expect(namedTestExists(journey, title, journeyRegistrations(`${imported} ${source}`, specifier)), source).toBe(false);
  for (const body of [
    `function unused() { test('${title}', () => {}); }`,
    `test('outer', () => { test('${title}', () => {}); });`,
    `if (true) { test('${title}', () => {}); }`,
    `test.skip(false); test('${title}', () => {});`,
  ]) expect(namedTestExists(`export function registerReading() { ${body} }`, title, registered), body).toBe(false);
  const explicit = journeyRegistrations(`${imported} const devices = ['tablet'] as const; register(devices);`, specifier);
  expect(namedTestExists(journey, 'tablet: choose the last chapter', explicit)).toBe(true);
  const empty = journeyRegistrations(`${imported} register([]);`, specifier);
  expect(namedTestExists(journey, 'phone: choose the last chapter', empty)).toBe(false);
});

test('launch outcomes retain landed proofs, the recipe reading name and all five new Zone rows', () => {
  const rows = (kind: (typeof kinds)[number], capability: string) =>
    launchCoverage.filter(row => row.kind === kind && row.capability === capability);
  const recipeHub = rows('recipes', 'Work hub and reading');
  expect(recipeHub).toHaveLength(1);
  expect(recipeHub[0]!.api).toMatchObject({
    test: 'recipes / Pinned Schema.org imports retain ordered content, quantities and separate flour steps',
  });
  expect(recipeHub[0]!.browser).toMatchObject({
    test: 'recipes / Search and open Puff Paste and Artusi in English UI',
  });
  expect(rows('recipes', 'Work hub and edition choice')).toHaveLength(0);
  const recipeCatalogue = rows('recipes', 'Catalogue browse and search in its Zone');
  expect(recipeCatalogue).toHaveLength(1);
  expect(recipeCatalogue[0]!.api).toMatchObject({
    test: 'recipes / Catalogue browse and search in its Zone cover all 30 Works across pages',
  });
  expect(recipeCatalogue[0]!.browser).toMatchObject({
    test: 'recipes / Search and open Puff Paste and Artusi in English UI',
  });
  const recipePagination = rows('recipes', 'Catalogue pagination in its Zone');
  expect(recipePagination).toHaveLength(1);
  expect(recipePagination[0]!.api).toMatchObject({
    test: 'recipes / Catalogue browse and search in its Zone cover all 30 Works across pages',
  });
  expect(recipePagination[0]!.browser).toMatchObject({
    test: 'recipes / Browse every recipe page in its Zone',
  });
  expect(rows('recipes', 'Collection tracking and progress')).toEqual([
    expect.objectContaining({ api: {
      file: 'tests/qa/integration/outcomes/recipes/collection-tracking-and-progress.test.ts',
      test: 'recipes/collection-tracking-and-progress / owner: curates repeated recipe members and retains private standing with replay and stale protection',
      evidence: 'Publishes an original Recipe, curates repeated collection members and checks private whole-recipe standing, replay and stale protection across all six personas. Passed in QA 20261015t015605-ab33e2.',
    },
      browser: expect.objectContaining({ file: 'apps/web/tests/recipe-tracking.e2e.ts',
        test: 'recipe-tracking / en: a cook saves a recipe, completes it and returns to persisted progress',
        evidence: expect.stringContaining('ordinary signed-in cook creates and publishes an original Recipe') }) }),
  ]);
  expect(rows('zone', 'Publication')[0]!.browser).toMatchObject({
    test: 'Navigation and theme: a Realm-less Zone publishes the saved home, navigation, and layout as one site',
    evidence: 'Retries an interrupted publish with one key, verifies the original receipt and cuts, and checks anonymous readers retain the published page through later private drafts.',
  });

  const provedRows = [
    ['anime', 'Work hub and edition choice', 'tests/qa/integration/anime-manga-hub.test.ts', 'apps/web/tests/anime-manga-hub.e2e.ts'],
    ['manga', 'Work hub and edition choice', 'tests/qa/integration/anime-manga-hub.test.ts', 'apps/web/tests/anime-manga-hub.e2e.ts'],
    ['manga', 'Collection tracking and progress', 'tests/qa/integration/typed-progress.test.ts', 'apps/web/tests/tracking-media.e2e.ts'],
    ['manga', 'Continue progress across devices', 'tests/qa/integration/typed-progress.test.ts', 'apps/web/tests/tracking-media.e2e.ts'],
    ['games', 'Collection tracking and progress', 'tests/qa/integration/game-progress.test.ts', 'apps/web/tests/tracking-media.e2e.ts'],
    ['games', 'Continue progress across devices', 'tests/qa/integration/game-progress.test.ts', 'apps/web/tests/tracking-media.e2e.ts'],
    ['recipes', 'Work hub and reading', 'tests/qa/integration/launch-real-recipes.test.ts', 'apps/web/tests/launch-real-recipes.e2e.ts'],
    ['recipes', 'Catalogue browse and search in its Zone', 'tests/qa/integration/launch-real-recipes.test.ts', 'apps/web/tests/launch-real-recipes.e2e.ts'],
    ['recipes', 'Catalogue pagination in its Zone', 'tests/qa/integration/launch-real-recipes.test.ts', 'apps/web/tests/launch-real-recipes.e2e.ts'],
    ['recipes', 'Exchange recipes', 'tests/qa/integration/recipe-structure.test.ts', 'apps/web/tests/recipe-exchange.e2e.ts'],
    ['zone', 'Navigation and theme', 'tests/qa/integration/zone-document-home.test.ts', 'apps/web/tests/zone-site-authoring.e2e.ts'],
    ['zone', 'Publish after editor revocation', 'tests/qa/integration/zone-document-home.test.ts', 'apps/web/tests/zone-site-authoring.e2e.ts'],
    ['zone', 'Home rendering', 'tests/qa/integration/zone-document-home.test.ts', 'apps/web/tests/zone-site-authoring.e2e.ts'],
    ['zone', 'Lifecycle', 'tests/qa/integration/zone-document-home.test.ts', 'apps/web/tests/zone-site-authoring.e2e.ts'],
    ['zone', 'Attach a Realm', 'tests/qa/integration/zone-realm-attachment.test.ts', 'apps/web/tests/zone-realm-attachment.e2e.ts'],
    ['zone', 'List attached Zones', 'tests/qa/integration/zone-realm-attachment.test.ts', 'apps/web/tests/zone-realm-attachment.e2e.ts'],
    ['zone', 'Withdraw a Realm attachment', 'tests/qa/integration/zone-realm-attachment.test.ts', 'apps/web/tests/zone-realm-attachment.e2e.ts'],
  ] as const;
  for (const [kind, capability, apiFile, browserFile] of provedRows) {
    const matches = rows(kind, capability);
    expect(matches, `${kind} / ${capability}`).toHaveLength(1);
    expect(matches[0]!.api).toMatchObject({ file: apiFile });
    expect(matches[0]!.browser).toMatchObject({ file: browserFile });
    for (const proof of [matches[0]!.api, matches[0]!.browser]) {
      expect(proofMissing(proof), `${kind} / ${capability}`).toBe(false);
      if (!proofMissing(proof)) expect(proof.evidence?.trim().length).toBeGreaterThan(0);
    }
  }

  const provedPairs = launchCoverage.filter(row => !proofMissing(row.api) && !proofMissing(row.browser));
  const missingRows = launchCoverage.filter(row => proofMissing(row.api) || proofMissing(row.browser));
  const missingProofs = launchCoverage.flatMap(row => [row.api, row.browser]).filter(proofMissing);
  expect({ rows: launchCoverage.length, provedPairs: provedPairs.length, missingRows: missingRows.length, missingProofs: missingProofs.length })
    .toEqual({ rows: 80, provedPairs: 68, missingRows: 12, missingProofs: 24 });
  expect(Object.fromEntries([...missingItems].map(item => [item,
    missingRows.filter(row => missingForRow(row).includes(item)).length,
  ]))).toEqual({ L10: 0, L11: 0, L12: 0, L13: 0, L17: 0, L19: 0, L20: 0, L21: 0, L26: 0, gap: 12, 'content-adoption': 0 });
});

test('hub structure browser coverage records three consecutive passing runs', () => {
  const rows = launchCoverage.filter(row => 'file' in row.browser &&
    row.browser.file === 'apps/web/tests/g-837-work-levels.e2e.ts');
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.capability).toBe('Anime, manga and VN hub parts, wholes and relations');
  expect(row.browser).toMatchObject({
    evidence: expect.stringContaining('Three consecutive passes: 20261015t193150-c51003, 20261015t193801-870024, 20261015t194429-70a0a5.'),
  });
  expect(proofMissing(row.browser)).toBe(false);
  expect(launchCoverage.filter(candidate => !proofMissing(candidate.api) && !proofMissing(candidate.browser)))
    .toContain(row);
});

test('literal loops and registered journeys retain all eleven browser citations', () => {
  const restored = [
    ['visual-novels', 'Catalogue browse and search in its Zone'],
    ['anime', 'Catalogue browse and search in its Zone'],
    ['manga', 'Catalogue browse and search in its Zone'],
    ['games', 'Work hub and edition choice'],
    ['games', 'Catalogue browse and search in its Zone'],
    ['realm', 'Membership and admission'],
    ['zone', 'Home rendering'],
    ['books', 'Choose among ambiguous editions of one Work'],
    ['books', 'Choose among mixed formats'],
    ['books', 'Navigate a thousand-chapter inventory'],
    ['books', 'Continue progress across devices'],
  ];
  for (const [kind, capability] of restored) {
    const row = launchCoverage.find(candidate => candidate.kind === kind && candidate.capability === capability);
    expect(row, `${kind} / ${capability}`).toBeDefined();
    expect(proofMissing(row!.browser), `${kind} / ${capability}`).toBe(false);
  }
});

test('every Realm closure surface records its API proof and observed browser journeys', () => {
  const outcomeFiles = [
    ['direct routes', 'closure-direct-routes'],
    ['threads and replies', 'closure-threads-and-replies'],
    ['Zone discussion entry and modules', 'closure-zone-discussion-entry-and-modules'],
    ['feed', 'closure-feed'],
    ['rankings', 'closure-rankings'],
    ['search', 'closure-search'],
    ['notifications', 'closure-notifications'],
    ['media', 'closure-media'],
    ['roster', 'closure-roster'],
  ];
  const closureRows = launchCoverage.filter(row => row.kind === 'realm' && row.capability.startsWith('Closure: '));
  expect(closureRows).toHaveLength(10);
  for (const [surface, file] of outcomeFiles) {
    const rows = closureRows.filter(row => row.capability === `Closure: ${surface}`);
    expect(rows, surface).toHaveLength(1);
    expect(rows[0]!.api, surface).toMatchObject({
      file: `tests/qa/integration/outcomes/realm/${file}.test.ts`,
    });
  }
  const directory = closureRows.find(row => row.capability === 'Closure: directory');
  expect(directory!.api).toMatchObject({
    file: 'services/main/tests/realm-platform-closure-reads.test.ts',
    test: 'closed-directory-before-drain: hidden indexed rows are omitted and live rows remain traversable',
  });
  for (const row of closureRows) {
    expect(proofMissing(row.browser), row.capability).toBe(false);
    if (!proofMissing(row.browser)) expect(row.browser.evidence?.trim().length, row.capability).toBeGreaterThan(0);
  }
  for (const [surface, title] of [
    ['direct routes', 'realm-closure-direct: readers and the Realm owner lose direct pages after reload and recover after restoration'],
    ['threads and replies', 'realm-closure-threads: a reader cannot reopen an opening or nested reply until the Realm is restored'],
    ['directory', 'realm-closure-directory: a newcomer sees only live communities after reload and follows one by keyboard'],
    ['Zone discussion entry and modules', 'realm-closure-zone: a visitor keeps the independent Zone while its Realm discussion and shelf disappear after reload'],
  ] as const) {
    expect(closureRows.find(row => row.capability === `Closure: ${surface}`)!.browser).toMatchObject({
      file: 'apps/web/tests/realm-route-closure.e2e.ts',
      test: title,
    });
  }
  for (const [surface, file, title] of [
    ['feed', 'apps/web/tests/realm-closure-discovery.e2e.ts',
      'realm-closure-feed: a returning member loses closed Realm results after reload and keeps the original'],
    ['rankings', 'apps/web/tests/realm-closure-discovery.e2e.ts',
      'realm-closure-rankings: a returning member loses closed Realm results after reload and keeps the original'],
    ['search', 'apps/web/tests/realm-closure-search.e2e.ts',
      'realm-closure-search: a returning member loses closed Realm results after reload and keeps the original'],
  ] as const) {
    expect(closureRows.find(row => row.capability === `Closure: ${surface}`)!.browser).toMatchObject({
      file,
      journey: 'apps/web/tests/journeys/realm-closure-discovery.ts',
      test: title,
    });
  }
});

test('Realm closure browser coverage registers the proved notification, media and roster journeys in both locales', () => {
  const rows = launchCoverage.filter(row => row.kind === 'realm');
  const file = 'apps/web/tests/realm-closure.e2e.ts';
  const journeyPath = 'apps/web/tests/journeys/realm-closure.ts';
  const wrapper = readFileSync(resolve(repositoryRoot, file), 'utf8');
  const journey = readFileSync(resolve(repositoryRoot, journeyPath), 'utf8');
  const registrations = journeyRegistrations(wrapper, './journeys/realm-closure.ts');
  for (const [surface, title] of [
    ['notifications', 'realm-closure-notifications: a recipient reloads a concealed reply notice and keeps the independent notice (en)'],
    ['media', 'realm-closure-media: a reader reloads reply-backed art as unavailable while independent art survives, then sees restoration (en)'],
    ['roster', 'realm-closure-roster: a founder and listed member reload concealed public and management rosters, then recover unchanged membership (en)'],
  ] as const) {
    const browser = rows.find(row => row.capability === `Closure: ${surface}`)!.browser;
    expect(proofMissing(browser), surface).toBe(false);
    expect(browser, surface).toMatchObject({ file, journey: journeyPath, test: title });
    expect(namedTestExists(journey, title, registrations), `${surface} (en)`).toBe(true);
    expect(namedTestExists(journey, title.replace('(en)', '(ja)'), registrations), `${surface} (ja)`).toBe(true);
  }
});

test('every launch kind and hard case has a coverage row', () => {
  for (const kind of kinds) expect(launchCoverage.some((row) => row.kind === kind), `${kind} has a row`).toBe(true);
  for (const hardCase of hardCases) {
    expect(launchCoverage.some((row) => row.hardCase === hardCase), `${hardCase} has a row`).toBe(true);
  }
  for (const { kind, hardCase } of requiredHardCaseRows) {
    expect(launchCoverage.some((row) => row.kind === kind && row.hardCase === hardCase), `${kind} ${hardCase} has a row`).toBe(true);
  }
});
