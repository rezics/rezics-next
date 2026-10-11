import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { expect, test } from 'bun:test';
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
  return [...source.matchAll(declaration)].some((match) => match[2]!.replace(/^G-?\d+(?::\s*|\s+)/, '') === title);
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
  for (const tag of ['G123: ', 'G-123: ', 'G123 ', 'G-123 ']) {
    const source = 'test(`' + tag + '${viewport.width}: choose the last chapter`, async () => {});';
    expect(namedTestExists(source, '${viewport.width}: choose the last chapter')).toBe(true);
    expect(namedTestExists(source, 'choose the last chapter')).toBe(false);
    expect(namedTestExists(source, tag + '${viewport.width}: choose the last chapter')).toBe(false);
  }
  expect(namedTestExists("test('a reader saves a choice', () => {});", 'a reader saves a choice')).toBe(true);
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
