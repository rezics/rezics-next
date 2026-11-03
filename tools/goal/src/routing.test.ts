import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief, pathsOverlap, readRiskOwnership } from './briefs.ts';
import { classifyTask, parseRouting, readRouting, routeTask } from './routing.ts';
import { brief, markdown } from './test-support.ts';

const ownership = readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
const table = readRouting(join(import.meta.dir, '../routing.json'));
test('risk ownership intersects declared globs, including a broad claim and zero-directory **', () => {
  expect(() => parseBrief(markdown.replace('[result.txt]', '[src/auth/token.ts]'), ownership)).toThrow('authorization');
  expect(() => parseBrief(markdown.replace('[result.txt]', '[src/**]'), ownership)).toThrow('risk area');
  expect(() => parseBrief(markdown.replace('[result.txt]', '[auth/**]'), ownership)).toThrow('authorization');
  expect(pathsOverlap('src/a*.ts', 'src/*b.ts')).toBe(true);
  expect(pathsOverlap('src/*.ts', 'src/auth/**')).toBe(false);
  expect(() => parseBrief(markdown.replace('[result.txt]', '[../auth/**]'), ownership)).toThrow('invalid');
  const risk = parseBrief(
    markdown.replace('[result.txt]', '[src/auth/token.ts]').replace('riskAreas: []', 'riskAreas: [authorization]'),
    ownership,
  );
  expect(classifyTask(risk)).toBe('claim');
});
test('routing uses observable features and task sequence; retry sequence does not rerandomize the experiment', () => {
  expect(routeTask(brief(), 1, table).profile.model).toBe('grok-4.7');
  expect(routeTask(brief(), 2, table).profile.model).toBe('grok-4.7');
  expect(routeTask(brief(), 3, table).profile).toMatchObject({ model: 'gpt-6-luna', effort: 'max' });
  expect(routeTask(brief(), 4, table).profile.model).toBe('grok-4.7');
  expect(routeTask(brief(), 3, table).experiment).toBe('implementation-model');
  expect(routeTask(brief(), 3, table).tableVersion).toBe(table.version);
  expect(classifyTask({ ...brief(), hostileInput: true })).toBe('claim');
  expect(classifyTask({ ...brief(), citesSources: true })).toBe('claim');
  expect(classifyTask({ ...brief(), criticalPath: true, inseparable: true, waiting: ['dependent'] })).toBe(
    'critical-path',
  );
  for (const kind of ['interface', 'bulk-text', 'specification', 'research', 'mechanical'] as const)
    expect(classifyTask({ ...brief(), kind })).toBe(kind);
  expect(() => classifyTask({ ...brief(), estimate: { lines: 4001, files: 8 } })).toThrow('manager');
  expect(() => classifyTask({ ...brief(), estimate: { lines: 2500, files: 61 } })).toThrow('manager');
  expect(classifyTask({ ...brief(), estimate: { lines: 4000, files: 60 } })).toBe('implementation');
  expect(() => classifyTask({ ...brief(), acceptance: { ...brief().acceptance, failing: false } })).toThrow('manager');
});

test('a brief that pins a Codex model and effort runs on it, outside any experiment', () => {
  const pinned = routeTask({ ...brief(), model: 'gpt-6.1-sol', effort: 'max' }, 1, table);
  expect(pinned.profile.cli).toBe('codex');
  expect(pinned.profile.model).toBe('gpt-6.1-sol');
  expect(pinned.profile.effort).toBe('max');
  expect(pinned.experiment).toBeNull();
  expect(routeTask({ ...brief(), model: 'gpt-6.1-terra' }, 1, table).profile.effort).toBe('high');
  expect(() => routeTask({ ...brief(), model: 'grok-4.7' }, 1, table)).toThrow('Codex model');
});

test('a brief parses its pinned model and effort from front matter', () => {
  const parsed = parseBrief(
    markdown.replace('waiting: []', 'waiting: []\nmodel: gpt-6.1-sol\neffort: xhigh'),
    ownership,
  );
  expect(parsed.model).toBe('gpt-6.1-sol');
  expect(parsed.effort).toBe('xhigh');
});

test('a research brief stays research when it cites sources or names risk areas', () => {
  expect(classifyTask({ ...brief(), kind: 'research', citesSources: true } as never)).toBe('research');
  expect(classifyTask({ ...brief(), kind: 'research', riskAreas: ['disclosure'] } as never)).toBe('research');
});

test('malformed routing fails with the responsible field named', () => {
  const valid = JSON.parse(readFileSync(join(import.meta.dir, '../routing.json'), 'utf8'));
  const cases: [string, (table: Record<string, any>) => void][] = [
    ['classes.implementation.maxMs', (table) => (table.classes.implementation.maxMs = Infinity)],
    ['classes.implementation.maxSteps', (table) => (table.classes.implementation.maxSteps = '300')],
    ['classes.research', (table) => delete table.classes.research],
    ['classes.implementation.fallbacks', (table) => (table.classes.implementation.fallbacks = {})],
    ['classes.implementation.first.effort', (table) => (table.classes.implementation.first.effort = 'extreme')],
    ['classes.implementation.fallbacks[0].model', (table) => (table.classes.implementation.fallbacks[0].model = 1)],
    ['experiments[0].profiles', (table) => (table.experiments[0].profiles = [])],
    ['experiments[0].open', (table) => (table.experiments[0].open = 'yes')],
    ['experiments[0].class', (table) => (table.experiments[0].class = 'mechanical')],
    ['consultation.cli', (table) => (table.consultation.cli = 'unknown')],
    ['version', (table) => (table.version = 0)],
    ['experiments', (table) => (table.experiments = {})],
    ['classes.implementation.paced', (table) => (table.classes.implementation.paced = 'yes')],
  ];
  for (const [field, mutate] of cases) {
    const table = structuredClone(valid);
    mutate(table);
    expect(() => parseRouting(table)).toThrow(field);
  }
  // Live routing files number their versions.
  expect(parseRouting({ ...structuredClone(valid), version: 24 }).version).toBe('24');
});
