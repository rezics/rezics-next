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

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namedTestExists(source: string, title: string): boolean {
  const declaration = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,/g;
  // Older test titles open with a task tag (a G, an optional hyphen, digits and a colon or space); the registry names the
  // exact source title after it, so no task identifier is copied into the registry.
  const matches = (candidate: string) => candidate.replace(/^G-?\d+(?::\s*|\s+)/, '') === title;
  if ([...source.matchAll(declaration)].some((match) => matches(match[2]!))) return true;

  // A table title is evidence only when that table registers tests through its loop variable.
  const parsed = ts.createSourceFile('proof.ts', source, ts.ScriptTarget.Latest, true);
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
    const callback = call.arguments[1];
    if (!ts.isIdentifier(call.expression) || !['test', 'it'].includes(call.expression.text) ||
      !argument || !ts.isPropertyAccessExpression(argument) || !ts.isIdentifier(argument.expression) ||
      argument.expression.text !== binding.text || argument.name.text !== 'title' ||
      !callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) continue;
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
  const imports = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
  for (const match of wrapper.matchAll(imports)) {
    if (match[3] !== moduleSpecifier) continue;
    for (const binding of match[1]!.split(',')) {
      const names = binding.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!names) continue;
      const localName = names[2] ?? names[1]!;
      if (new RegExp(`\\b${escaped(localName)}\\s*\\(`).test(wrapper)) return true;
    }
  }
  return false;
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
  return [
    ...(proofMissing(row.api) ? [`API ${row.api.missing}`] : []),
    ...(proofMissing(row.browser) ? [`browser ${row.browser.missing}`] : []),
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
          errors.push(`${rowLabel(row)}: test not found in journey ${proof.journey}: ${proof.test}`);
        }
      } else if (!namedTestExists(source, proof.test)) {
        errors.push(`${rowLabel(row)}: test not found in ${proof.file}: ${proof.test}`);
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
