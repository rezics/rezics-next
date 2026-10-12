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
    members.every(member => ['only', 'skip', 'skipIf', 'todo', 'fixme', 'fail', 'if', 'each'].includes(member)) &&
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
    members.some(member => ['skip', 'skipIf', 'fixme', 'fail', 'todo', 'if'].includes(member));
}

function scopeHasRuntimeSkip(scope: ts.Node): boolean {
  let disabled = false;
  const visit = (node: ts.Node): void => {
    if (disabled) return;
    if (ts.isCallExpression(node)) {
      // Sibling declarations and their hooks belong to their own test or suite.
      if (isTestDeclaration(node) || isSuiteDeclaration(node)) return;
      const path = testApiPath(node.expression);
      if (['test', 'it'].includes(path[0] ?? '') && ['skip', 'fixme', 'fail'].includes(path.at(-1) ?? '')) {
        disabled = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return disabled;
}

/**
 * Proof validation is syntactic and deliberately conservative, not execution modelling.
 * A test declaration has a string, template or reference title and an inline function
 * body after that title (with optional Playwright options or a Bun timeout). Skipped
 * sibling declarations have their own scopes and never disqualify another proof.
 * A test.skip/fixme/fail call without such a body is a runtime skip; a first-argument
 * predicate is not a test body. Any runtime skip rejects its enclosing proof, describe
 * or file scope, including hooks, unused helpers and untaken branches. Conditions are
 * never evaluated: test.skip(false) still rejects that scope.
 * Skip/fixme/todo/if/skipIf suite modifiers (including test.describe.skip) reject all
 * contained tests and journey registrations regardless of their condition's value.
 * The same scope rule applies to direct tests, table registrations and journey wrappers.
 * False rejections are intentional: cited proofs must have scopes free of skip constructs.
 */
function proofScopeIsUnskipped(call: ts.CallExpression): boolean {
  for (let node: ts.Node | undefined = call; node; node = node.parent) {
    if (ts.isCallExpression(node) && hasSkipModifier(node)) return false;
    if ((ts.isBlock(node) || ts.isSourceFile(node)) && scopeHasRuntimeSkip(node)) return false;
  }
  const callback = testCallback(call);
  return !callback || !scopeHasRuntimeSkip(callback.body);
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
      if (candidate !== undefined && matches(candidate) && proofScopeIsUnskipped(node)) found = true;
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
      !proofScopeIsUnskipped(call)) continue;
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
      registrations.has(node.expression.text) && proofScopeIsUnskipped(node)) found = true;
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
          errors.push(`${rowLabel(row)}: unskipped test declaration not found in journey ${proof.journey}: ${proof.test}`);
        }
      } else if (!namedTestExists(source, proof.test)) {
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
    { source: `test.if(true)('${title}', () => {});`, accepted: false },
    { source: `test.skipIf(false)('${title}', () => {});`, accepted: false },
    { source: `test.skip('another test', () => {}); ${declaration}`, accepted: true },
    { source: `test.fixme('another test', () => { test.skip(); }); ${declaration}`, accepted: true },
    { source: `test.skip('another test', { tag: '@launch' }, () => {}); ${declaration}`, accepted: true },
    { source: `test.skip(otherTitle, () => {}); ${declaration}`, accepted: true },
    { source: `test.skip(otherTitle, function () {}); ${declaration}`, accepted: true },
    { source: `test.fixme(otherTitle, () => { test.fail(); }); ${declaration}`, accepted: true },
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
  expect(namedTestExists(`test.skip(otherTitle, () => {}); ${source}`, 'a reader chooses a format')).toBe(true);
  for (const modifier of ['skip', 'fixme', 'fail']) {
    for (const skip of [`test.${modifier}(false);`, `test.${modifier}(() => true);`]) {
      for (const scope of [skip, `function unused() { ${skip} }`, `if (false) { ${skip} }`,
        `test.beforeEach(() => { ${skip} });`]) {
        expect(namedTestExists(`${scope} ${source}`, 'a reader chooses a format'), scope).toBe(false);
      }
    }
  }
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
