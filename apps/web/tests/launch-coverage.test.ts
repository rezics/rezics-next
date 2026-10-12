import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { expect, test } from 'bun:test';
import ts from 'typescript-6';
import { launchCoverage, type JourneyProof, type Proof } from '../../../scripts/qa/cases/launch-coverage.ts';

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

function literalCondition(expression: ts.Expression | undefined): boolean | undefined {
  if (!expression) return undefined;
  if (ts.isParenthesizedExpression(expression)) return literalCondition(expression.expression);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = literalCondition(expression.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

function testApiPath(expression: ts.Expression): string[] {
  if (ts.isCallExpression(expression)) return testApiPath(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) return [...testApiPath(expression.expression), expression.name.text];
  return ts.isIdentifier(expression) ? [expression.text] : [];
}

function testCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // Playwright accepts (title, options, fn); Bun accepts (title, fn, timeout).
  return call.arguments.findLast((argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
    ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
}

function isTestDeclaration(call: ts.CallExpression): boolean {
  const [root, ...members] = testApiPath(call.expression);
  return (root === 'test' || root === 'it') &&
    members.every(member => ['only', 'skip', 'skipIf', 'todo', 'fixme', 'if', 'each'].includes(member)) &&
    testCallback(call) !== undefined;
}

function isSuiteDeclaration(call: ts.CallExpression): boolean {
  const path = testApiPath(call.expression);
  return ['test', 'describe'].includes(path[0] ?? '') && path.includes('describe') && testCallback(call) !== undefined;
}

function disablesTest(call: ts.CallExpression): boolean {
  if (!['test', 'it', 'describe'].includes(testApiPath(call.expression)[0] ?? '')) return false;
  let expression: ts.Expression = call;
  while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const modifier = expression.expression.name.text;
      const condition = literalCondition(expression.arguments[0]);
      if (modifier === 'todo' || (['skip', 'skipIf', 'fixme'].includes(modifier) && condition !== false) ||
        (modifier === 'if' && condition !== true)) return true;
    }
    expression = expression.expression;
  }
  return false;
}

function scopeDisablesTest(scope: ts.Node, includeFunctions = false): boolean {
  let disabled = false;
  const visit = (node: ts.Node): void => {
    if (disabled) return;
    if (ts.isFunctionLike(node)) {
      if (includeFunctions && 'body' in node && node.body) visit(node.body);
      return;
    }
    if (ts.isIfStatement(node)) {
      const condition = literalCondition(node.expression);
      if (condition !== false) visit(node.thenStatement);
      if (condition !== true && node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      visit(node.left);
      const condition = literalCondition(node.left);
      if (condition === undefined || condition === (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) visit(node.right);
      return;
    }
    if (ts.isCallExpression(node)) {
      // Sibling declarations and their hooks belong to their own test or suite.
      if (isTestDeclaration(node) || isSuiteDeclaration(node)) return;
      const path = testApiPath(node.expression);
      if (['beforeEach', 'beforeAll'].includes(path.at(-1) ?? '') &&
        (path.length === 1 || path[0] === 'test')) {
        const callback = testCallback(node);
        if (callback) disabled ||= scopeDisablesTest(callback.body, true);
      }
      // A todo/skip with a title but no body still declares an unrelated sibling.
      if (!ts.isStringLiteralLike(node.arguments[0] ?? node) && disablesTest(node)) disabled = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return disabled;
}

function activeTest(call: ts.CallExpression): boolean {
  for (let node: ts.Node | undefined = call; node; node = node.parent) {
    const parent: ts.Node | undefined = node.parent;
    if (ts.isCallExpression(node) && disablesTest(node)) return false;
    if ((ts.isBlock(node) || ts.isSourceFile(node)) && scopeDisablesTest(node)) return false;
    // A declaration hidden behind a runtime condition cannot establish that it runs.
    if (parent && ts.isIfStatement(parent) && literalCondition(parent.expression) !== (parent.thenStatement === node)) return false;
    if (parent && ts.isConditionalExpression(parent) && node !== parent.condition &&
      literalCondition(parent.condition) !== (parent.whenTrue === node)) return false;
    if (parent && ts.isBinaryExpression(parent) && parent.right === node &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) &&
      literalCondition(parent.left) !== (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return false;
  }
  const callback = testCallback(call);
  return !callback || !scopeDisablesTest(callback.body, true);
}

function namedTestExists(source: string, title: string): boolean {
  const parsed = ts.createSourceFile('proof.ts', source, ts.ScriptTarget.Latest, true);
  // Older test titles open with a task tag; the registry keeps the exact title after it.
  const matches = (candidate: string) => candidate.replace(/^G-?\d+(?::\s*|\s+)/, '') === title;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestDeclaration(node)) {
      const argument = node.arguments[0];
      const candidate = argument && (ts.isStringLiteralLike(argument) ? argument.text
        : ts.isTemplateExpression(argument) ? argument.getText(parsed).slice(1, -1) : undefined);
      if (candidate !== undefined && matches(candidate) && activeTest(node)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (found) return true;

  // A table title is evidence only when that table registers tests through its loop variable.
  const tables = new Map<string, ts.ArrayLiteralExpression>();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && entry.initializer && ts.isArrayLiteralExpression(entry.initializer)) {
        tables.set(entry.name.text, entry.initializer);
      }
    }
  }
  for (const loop of parsed.statements) {
    if (!ts.isForOfStatement(loop) || !ts.isIdentifier(loop.expression) ||
      !ts.isVariableDeclarationList(loop.initializer) || !(loop.initializer.flags & ts.NodeFlags.Const) ||
      loop.initializer.declarations.length !== 1) continue;
    const binding = loop.initializer.declarations[0]!.name;
    const body = ts.isBlock(loop.statement) && loop.statement.statements.length === 1
      ? loop.statement.statements[0]! : loop.statement;
    if (!ts.isIdentifier(binding) || !ts.isExpressionStatement(body) || !ts.isCallExpression(body.expression)) continue;
    const call = body.expression;
    const argument = call.arguments[0];
    if (!isTestDeclaration(call) ||
      !argument || !ts.isPropertyAccessExpression(argument) || !ts.isIdentifier(argument.expression) ||
      argument.expression.text !== binding.text || argument.name.text !== 'title' ||
      !activeTest(call)) continue;
    for (const entry of tables.get(loop.expression.text)?.elements ?? []) {
      if (!ts.isObjectLiteralExpression(entry) || entry.properties.some(property => ts.isSpreadAssignment(property) ||
        (property.name && ts.isComputedPropertyName(property.name)))) continue;
      const properties = entry.properties.filter(property => property.name &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'title');
      const property = properties[0];
      if (properties.length === 1 && property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) &&
        matches(property.initializer.text)) return true;
    }
  }
  return false;
}

function proofMissing(proof: Proof): proof is Extract<Proof, { missing: string }> {
  return 'missing' in proof;
}

function journeyProof(proof: Proof): proof is JourneyProof {
  return 'journey' in proof;
}

function journeyRegistered(wrapper: string, moduleSpecifier: string): boolean {
  const parsed = ts.createSourceFile('wrapper.ts', wrapper, ts.ScriptTarget.Latest, true);
  const registrations = new Set<string>();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) registrations.add(binding.name.text);
      }
    }
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      registrations.has(node.expression.text) && activeTest(node)) {
      // A call in an unused helper or a test body does not register a journey at collection time.
      let collected = true;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionLike(parent) &&
          (!ts.isCallExpression(parent.parent) || !isSuiteDeclaration(parent.parent))) collected = false;
      }
      found ||= collected;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
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

test('launch coverage names existing tests and reports remaining rows', () => {
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
        if (!journeyRegistered(source, relativeModule)) {
          errors.push(`${rowLabel(row)}: ${proof.file} does not register ${proof.journey}`);
        }
        const journeySource = readFileSync(journeyPath, 'utf8');
        if (!namedTestExists(journeySource, proof.test)) {
          errors.push(`${rowLabel(row)}: runnable test not found in journey ${proof.journey}: ${proof.test}`);
        }
      } else if (!namedTestExists(source, proof.test)) {
        errors.push(`${rowLabel(row)}: runnable test not found in ${proof.file}: ${proof.test}`);
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

test('proof titles require runnable tests rather than skipped declarations or suites', () => {
  const title = 'a reader resumes on another device';
  const declaration = `test('${title}', () => {});`;
  expect(namedTestExists(declaration, title)).toBe(true);
  for (const disabled of ['skip', 'skipIf', 'fixme']) {
    expect(namedTestExists(`test.${disabled}('${title}', () => {});`, title)).toBe(false);
    expect(namedTestExists(`describe.${disabled}(true)('suite', () => { ${declaration} });`, title)).toBe(false);
    expect(namedTestExists(`test.describe.${disabled}('suite', () => { ${declaration} });`, title)).toBe(false);
    expect(namedTestExists(`describe.${disabled}('suite', () => { ${declaration} });`, title)).toBe(false);
    expect(namedTestExists(`test('${title}', () => { test.${disabled}(process.env.PROOF_DISABLED); });`, title)).toBe(false);
  }
  expect(namedTestExists(`describe.skipIf(!reviewUrl || !authPath)('shared stack', () => { ${declaration} });`, title)).toBe(false);
  expect(namedTestExists(`describe('outer', () => { describe.skip('inner', () => { ${declaration} }); });`, title)).toBe(false);
  expect(namedTestExists(`describe.skipIf(false)('suite', () => { ${declaration} });`, title)).toBe(true);
  expect(namedTestExists(`test('${title}', () => { test.skip(false); });`, title)).toBe(true);
  expect(namedTestExists(`test.skip(true); ${declaration}`, title)).toBe(false);
  expect(namedTestExists(`describe('suite', () => { if (disabled) test.fixme(true); ${declaration} });`, title)).toBe(false);
  expect(namedTestExists(`test.skip('unrelated journey', () => {}); ${declaration}`, title)).toBe(true);
  expect(namedTestExists(`test('unrelated journey', () => { test.skip(true); }); ${declaration}`, title)).toBe(true);
  expect(namedTestExists(`// ${declaration}`, title)).toBe(false);
  expect(namedTestExists(`const example = ${JSON.stringify(declaration)};`, title)).toBe(false);
  expect(namedTestExists(`test('${title}');`, title)).toBe(false);
});

test('proof execution follows hooks, suite conditions and Playwright options', () => {
  const title = 'a reader resumes on another device';
  const declaration = `test('${title}', () => {});`;
  const fixtures = [
    { source: `test.beforeEach(() => { test.skip(); }); ${declaration}`, runnable: false },
    { source: `beforeEach(() => { test.fixme(true); }); ${declaration}`, runnable: false },
    { source: `test.beforeAll(() => { test.skip(disabled); }); ${declaration}`, runnable: false },
    { source: `describe('suite', () => { beforeEach(() => { test.skip(true); }); ${declaration} });`, runnable: false },
    { source: `describe('outer', () => { test.beforeEach(() => { test.skip(true); }); describe('inner', () => { ${declaration} }); });`, runnable: false },
    { source: `test.beforeEach(() => { test.skip(false); }); ${declaration}`, runnable: true },
    { source: `test.beforeEach(() => { if (false) test.skip(true); }); ${declaration}`, runnable: true },
    { source: `test.beforeEach(async () => { await step(() => { test.skip(true); }); }); ${declaration}`, runnable: false },
    { source: `describe.todo('suite', () => { ${declaration} });`, runnable: false },
    { source: `describe.if(false)('suite', () => { ${declaration} });`, runnable: false },
    { source: `describe.if(enabled)('suite', () => { ${declaration} });`, runnable: false },
    { source: `describe.if(true)('suite', () => { ${declaration} });`, runnable: true },
    { source: `describe.skipIf(enabled)('suite', () => { ${declaration} });`, runnable: false },
    { source: `describe.skipIf(false)('suite', () => { ${declaration} });`, runnable: true },
    { source: `if (false) { ${declaration} }`, runnable: false },
    { source: `if (enabled) { ${declaration} }`, runnable: false },
    { source: `if (true) { ${declaration} }`, runnable: true },
    { source: `if (false) {} else { ${declaration} }`, runnable: true },
    { source: `if (true) {} else { ${declaration} }`, runnable: false },
    { source: `false && test('${title}', () => {});`, runnable: false },
    { source: `true || test('${title}', () => {});`, runnable: false },
    { source: `true && test('${title}', () => {});`, runnable: true },
    { source: `false || test('${title}', () => {});`, runnable: true },
    { source: `test.beforeEach(() => { false && test.skip(true); }); ${declaration}`, runnable: true },
    { source: `test.todo('${title}', () => {});`, runnable: false },
    { source: `test.if(false)('${title}', () => {});`, runnable: false },
    { source: `test.if(true)('${title}', () => {});`, runnable: true },
    { source: `test.skipIf(false)('${title}', () => {});`, runnable: true },
    { source: `test.skipIf(enabled)('${title}', () => {});`, runnable: false },
    { source: `test('${title}', { tag: '@launch' }, () => {});`, runnable: true },
    { source: `test('${title}', () => {}, 180_000);`, runnable: true },
    { source: `test('${title}', () => { test.skip(true); }, 180_000);`, runnable: false },
    { source: `test('${title}', { tag: '@launch' }, () => { test.skip(true); });`, runnable: false },
    { source: `test('${title}', { tag: '@launch' }, () => { test.fixme(enabled); });`, runnable: false },
    { source: `test('${title}', () => { step(() => { test.skip(true); }); });`, runnable: false },
    { source: `test.todo('another test'); ${declaration}`, runnable: true },
    { source: `test.skip('another test', { tag: '@launch' }, () => {}); ${declaration}`, runnable: true },
    { source: `describe.skip('another suite', () => { beforeEach(() => { test.skip(); }); }); ${declaration}`, runnable: true },
    { source: `describe('another suite', () => { test.beforeEach(() => { test.skip(); }); }); ${declaration}`, runnable: true },
  ];
  for (const { source, runnable } of fixtures) expect(namedTestExists(source, title), source).toBe(runnable);
});

test('journey imports count only when their registration runs', () => {
  const moduleSpecifier = './journeys/reading.ts';
  const imported = `import { registerReadingJourney as register } from '${moduleSpecifier}';`;
  const fixtures = [
    { source: 'register();', runnable: true },
    { source: `describe('suite', () => { register(); });`, runnable: true },
    { source: `describe.skip('suite', () => { register(); });`, runnable: false },
    { source: `test.describe.skip('suite', () => { register(); });`, runnable: false },
    { source: `describe.todo('suite', () => { register(); });`, runnable: false },
    { source: `describe.if(false)('suite', () => { register(); });`, runnable: false },
    { source: `describe.if(true)('suite', () => { register(); });`, runnable: true },
    { source: `describe.skipIf(disabled)('suite', () => { register(); });`, runnable: false },
    { source: `describe.skipIf(false)('suite', () => { register(); });`, runnable: true },
    { source: 'test.skip(true); register();', runnable: false },
    { source: 'test.beforeEach(() => { test.fixme(true); }); register();', runnable: false },
    { source: `describe('suite', () => { test.beforeEach(() => { test.skip(); }); register(); });`, runnable: false },
    { source: 'if (false) register();', runnable: false },
    { source: 'if (enabled) register();', runnable: false },
    { source: 'if (true) register();', runnable: true },
    { source: 'false && register();', runnable: false },
    { source: 'true || register();', runnable: false },
    { source: 'true && register();', runnable: true },
    { source: 'false || register();', runnable: true },
    { source: `describe.skip('another suite', () => {}); register();`, runnable: true },
    { source: `test('another test', () => { test.skip(true); }); register();`, runnable: true },
    { source: `test('another test', () => { register(); });`, runnable: false },
    { source: 'function unused() { register(); }', runnable: false },
    { source: '// register();', runnable: false },
    { source: `const example = 'register();';`, runnable: false },
  ];
  for (const { source, runnable } of fixtures) {
    expect(journeyRegistered(`${imported}\n${source}`, moduleSpecifier), source).toBe(runnable);
  }
  expect(journeyRegistered(imported, moduleSpecifier)).toBe(false);
  expect(journeyRegistered(`${imported} register();`, './journeys/other.ts')).toBe(false);
  expect(journeyRegistered(`import type { register } from '${moduleSpecifier}'; register();`, moduleSpecifier)).toBe(false);
});

test('proof titles in a table must be registered by that table’s test loop', () => {
  const source = `
    const unused = [{ title: 'an unused journey' }];
    const journeys = [
      { title: 'a reader chooses an edition', choices: [{ title: 'a nested choice' }] },
      { title: 'a reader chooses a format', choices: [] },
    ];
    for (const journey of journeys) test(journey.title, async () => {});
  `;
  expect(namedTestExists(source, 'a reader chooses an edition')).toBe(true);
  expect(namedTestExists(source, 'a reader chooses a format')).toBe(true);
  expect(namedTestExists(source, 'an unused journey')).toBe(false);
  expect(namedTestExists(source, 'a nested choice')).toBe(false);
  expect(namedTestExists(source.replace('journey.title', 'journey.label'), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('const journey of', 'const other of'), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('of journeys', 'of unused'), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace(', async () => {}', ''), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('for (const journey', '// for (const journey'), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('choices: [{', "title: 'another title', choices: [{"), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('choices: [{', '...unused[0], choices: [{'), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('choices: [{', "['title']: 'another title', choices: [{"), 'a reader chooses an edition')).toBe(false);
  expect(namedTestExists(source.replace('test(journey.title', 'it(journey.title'), 'a reader chooses a format')).toBe(true);
  expect(namedTestExists(source.replace('async () => {}', 'async () => { test.skip(true); }'), 'a reader chooses a format')).toBe(false);
  expect(namedTestExists(`test.beforeEach(() => { test.skip(); }); ${source}`, 'a reader chooses a format')).toBe(false);
  expect(namedTestExists(source.replace('test(journey.title', 'test.skip(journey.title'), 'a reader chooses a format')).toBe(false);
  expect(namedTestExists(source.replace('async () => {}', "{ tag: '@launch' }, async () => {}"), 'a reader chooses a format')).toBe(true);
  expect(namedTestExists(source.replace('async () => {}', "{ tag: '@launch' }, async () => { test.fixme(true); }"), 'a reader chooses a format')).toBe(false);
});

test('launch outcomes retain landed proofs, the recipe reading name and all five new Zone rows', () => {
  const rows = (kind: (typeof kinds)[number], capability: string) =>
    launchCoverage.filter(row => row.kind === kind && row.capability === capability);
  const recipeHub = rows('recipes', 'Work hub and reading');
  expect(recipeHub).toHaveLength(1);
  expect(recipeHub[0]!.api).toEqual({ missing: 'L21', reason: undefined });
  expect(recipeHub[0]!.browser).toEqual({ missing: 'L21', reason: undefined });
  expect(rows('recipes', 'Work hub and edition choice')).toHaveLength(0);
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
    .toEqual({ rows: 55, provedPairs: 39, missingRows: 16, missingProofs: 25 });
  expect(Object.fromEntries([...missingItems].map(item => [item,
    missingRows.filter(row => missingForRow(row).includes(item)).length,
  ]))).toEqual({ L10: 1, L11: 1, L12: 2, L13: 0, L17: 0, L19: 0, L20: 0, L21: 10, L26: 0, gap: 2 });
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
