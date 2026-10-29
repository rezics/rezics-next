import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { RELEASE_LIMITS, validateRelease } from '../src/index.ts';
import { analyzePattern } from '../src/pattern-safety.ts';
import {
  candidateAnalysisMax,
  constructionEvidence,
  constructionFixture,
  duplicatePointer,
  scales,
} from './support/publication-construction.ts';

test('copied native validation and dependency counters preserve full outputs on all independent shapes', async () => {
  const report = await constructionEvidence();
  expect(report.versions.typebox).toBe('1.4.3');
  expect(report.versions.recheck).toBe('4.5.0');
  expect(report.versions.canonicalize).toBe('5.1.0');
  for (const entry of Object.values(report.sources)) {
    expect(entry.original).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.instrumented).toMatch(/^[a-f0-9]{64}$/);
  }
  for (const row of report.rows) {
    expect(row.instrumented, row.name).toEqual(row.original);
    expect(row.bytes, row.name).toBeLessThan(RELEASE_LIMITS.bytes);
    if (row.mode !== 'release' || row.name.startsWith('duplicate-')) continue;
    if (row.name.includes('unique-members') || row.name.includes('unique-sites')) continue;
    if (row.name.includes('-false-')) expect(row.original, row.name).toEqual([]);
    else {
      expect(Array.isArray(row.original)).toBe(true);
      expect((row.original as unknown[]).length, row.name).toBeGreaterThan(0);
      expect((row.original as unknown[]).length, row.name).toBeLessThanOrEqual(64);
      const errors = row.original as { pointer: string; code: string }[];
      expect(
        errors.map((error) => error.pointer),
        row.name,
      ).toEqual(errors.map((error) => error.pointer).sort());
      expect(new Set(errors.map((error) => error.pointer)).size).toBe(errors.length);
      expect(errors.every((error) => error.code === 'invalid')).toBe(true);
      expect(errors[0]!.pointer).toStartWith('/filters/construction0~1f00/filter/');
      if (row.axes.filters! >= 64) expect(errors.length, row.name).toBe(64);
    }
  }
}, 240_000);

test('linear uniqueness diagnostics match the historical validator for malformed hashed members', async () => {
  const report = await constructionEvidence();
  const row = report.rows.find((candidate) => candidate.name === 'malformed-unique-members')!;
  expect(row.instrumented).toEqual(row.original);
  expect(row.original).toContainEqual({ pointer: '/types/grow:Root/mappings', code: 'invalid' });
  expect(row.original).toContainEqual({ pointer: '/types/grow:Root/mappings/0', code: 'invalid' });
  const sites = report.rows.find((candidate) => candidate.name === 'duplicate-unique-sites')!;
  expect(sites.instrumented).toEqual(sites.original);
});

for (const member of ['bases', 'mappings', 'qualifiers']) {
  test(`invalid duplicate-heavy ${member} must have linear native hash and Set work`, async () => {
    const report = await constructionEvidence();
    const excessive: unknown[] = [];
    for (const scale of scales) {
      const row = report.rows.find((row) => row.name === `duplicate-${member}-${scale}`)!;
      expect(row.original).toEqual([{ pointer: duplicatePointer(member), code: 'invalid' }]);
      const entries = row.axes.duplicates! + 1;
      expect(row.counts.duplicateVisits, row.name).toBe(entries);
      expect(row.counts.duplicateProbes, row.name).toBe(entries);
      expect(row.counts.duplicateAppends, row.name).toBeGreaterThanOrEqual(entries);
      const linearAllowance = 8 * (row.shape.nodes + row.shape.edges);
      for (const count of [
        row.counts.duplicateVisits,
        row.counts.duplicateProbes,
        row.counts.duplicateAppends,
        row.counts.hashNodes,
        row.counts.hashBytes,
      ])
        if (count > linearAllowance) excessive.push({ name: row.name, counts: row.counts, linearAllowance });
      console.log(
        'linear uniqueness native counts',
        JSON.stringify({ name: row.name, ...row.counts, linearAllowance }),
      );
    }
    expect(excessive, 'actual canonical hashing and Set membership must grow linearly').toEqual([]);
  }, 240_000);
}

test('ordinary native outcomes retain catalogue, one-level facets and cheap limits before patterns', () => {
  const release = constructionFixture(64, 64);
  for (const [key, value] of Object.entries(bundledRelease.types)) expect(release.types[key]).toEqual(value);
  for (const [key, value] of Object.entries(bundledRelease.properties)) expect(release.properties[key]).toEqual(value);
  expect(validateRelease(release)).toEqual([]);
  release.properties['grow:code']!.value = { type: 'string', minLength: 1, maxLength: 1500, pattern: '^(a+)+$' };
  expect(validateRelease(release)).toEqual([
    { pointer: '/properties/grow:code/value/pattern', code: 'unsafe_pattern' },
  ]);
  release.types['grow:Root']!.properties = Array(65).fill('grow:code');
  expect(validateRelease(release)).toEqual([{ pointer: '/types/grow:Root/properties', code: 'limit' }]);
});

test('sorted pattern checkpoint observation freezes same-pattern defect versus first excess without making defects safe', async () => {
  const report = await constructionEvidence();
  for (const row of report.patterns) expect(row.instrumented).toEqual(row.original);
  const exhaustion = report.patterns.find((row) => row.source === '^[ab]{32}a[ab]*$')!;
  expect(exhaustion.original).toEqual({ safe: false, steps: 8193 });
  const unsafe = report.patterns.find((row) => row.source === '^(a+)+$')!;
  expect(unsafe.original).toEqual({ safe: false, steps: 156 });
  expect(unsafe.native).toEqual([{ status: 'vulnerable', checker: 'automaton' }]);
  const unknown = report.patterns.find((row) => row.source === '^[ab]*a[ab]{32}$')!;
  expect(unknown.original).toEqual({ safe: false, steps: 457 });
  expect(unknown.native).toEqual([{ status: 'exception-or-unknown', steps: 457 }]);
  expect(exhaustion.native).toEqual([{ status: 'exception-or-unknown', steps: 8193 }]);
  const safe = report.patterns.find((row) => row.source === '^A$')!;
  expect(safe.original).toEqual({ safe: true, steps: 7 });
  expect(safe.native).toEqual([{ status: 'safe', checker: 'automaton' }]);
  // Fixture construction uses observed native literal costs. The admission
  // observation below executes every selected source again and sums actual steps.
  const singleSources = ['!', '"', '#', '%', '&', ',', '-', '/', ':'];
  for (const source of singleSources) expect(analyzePattern(source)).toEqual({ safe: true, steps: 4 });
  expect(analyzePattern('!0000')).toEqual({ safe: true, steps: 9 });
  for (const defect of [unsafe, exhaustion, unknown])
    for (const delta of [-1, 0, 1]) {
      const prefixTarget = candidateAnalysisMax - defect.original.steps + delta;
      const singles = Array.from({ length: 9 }, (_, index) => index).find(
        (count) => (prefixTarget - 4 * count) % 9 === 0,
      )!;
      const literals = (prefixTarget - 4 * singles) / 9;
      const sorted = [
        ...singleSources.slice(0, singles),
        ...Array.from({ length: literals }, (_, index) => `!${String(index).padStart(4, '0')}`),
        defect.source,
      ].sort();
      expect(sorted.at(-1)).toBe(defect.source);
      let executed = 0;
      let prefixSteps = 0;
      let last: { source: string; safe: boolean; excess: boolean; steps: number } | undefined;
      for (const source of sorted) {
        const actual = analyzePattern(source);
        executed += actual.steps;
        last = { source, safe: actual.safe, excess: executed > candidateAnalysisMax, steps: actual.steps };
        if (!actual.safe || last.excess) break;
        prefixSteps = executed;
      }
      expect(prefixSteps).toBe(prefixTarget);
      expect(last!.source).toBe(defect.source);
      expect(last!.safe).toBe(false);
      expect(last!.excess).toBe(delta > 0);
      expect(executed).toBe(candidateAnalysisMax + delta);
      expect(executed).toBeLessThanOrEqual(candidateAnalysisMax + 8193);
      console.log(
        'same-pattern native boundary',
        JSON.stringify({
          limit: candidateAnalysisMax,
          remaining: candidateAnalysisMax - prefixSteps,
          delta,
          prefixSteps,
          executed,
          last,
        }),
      );
    }
}, 240_000);
