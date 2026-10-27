import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseBrief, pathsOverlap, readRiskOwnership } from './briefs.ts';
import { classifyTask, readRouting, routeTask } from './routing.ts';
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
  const risk = parseBrief(markdown.replace('[result.txt]', '[src/auth/token.ts]').replace('riskAreas: []', 'riskAreas: [authorization]'), ownership);
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
  expect(classifyTask({ ...brief(), criticalPath: true, inseparable: true, waiting: ['dependent'] })).toBe('critical-path');
  for (const kind of ['interface', 'bulk-text', 'specification', 'research', 'mechanical'] as const) expect(classifyTask({ ...brief(), kind })).toBe(kind);
  expect(() => classifyTask({ ...brief(), estimate: { lines: 401, files: 8 } })).toThrow('manager');
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
  const parsed = parseBrief(markdown.replace('waiting: []', 'waiting: []\nmodel: gpt-6.1-sol\neffort: xhigh'), ownership);
  expect(parsed.model).toBe('gpt-6.1-sol');
  expect(parsed.effort).toBe('xhigh');
});
