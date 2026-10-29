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
    if (row.name.includes('-false-')) expect(row.original, row.name).toEqual([]);
    else {
      expect(Array.isArray(row.original)).toBe(true);
      expect((row.original as unknown[]).length, row.name).toBeGreaterThan(0);
      expect((row.original as unknown[]).length, row.name).toBeLessThanOrEqual(64);
    }
  }
}, 240_000);

for (const member of ['bases', 'mappings', 'qualifiers']) {
  test(`invalid duplicate-heavy ${member} must have linear native diagnostics before TypeBox Errors copies`, async () => {
    const report = await constructionEvidence();
    const excessive: unknown[] = [];
    for (const scale of scales) {
      const row = report.rows.find((row) => row.name === `duplicate-${member}-${scale}`)!;
      expect(row.original).toEqual([{ pointer: duplicatePointer(member), code: 'invalid' }]);
      // This is the replacement requirement, not an assertion blessing today's
      // quadratic result. The counter observes actual spread element iteration.
      const linearAllowance = 8 * (row.shape.nodes + row.shape.edges);
      if (row.counts.duplicateCopies > linearAllowance)
        excessive.push({ name: row.name, counts: row.counts, linearAllowance });
    }
    expect(excessive, 'own linear uniqueness diagnostics must precede dependency error enumeration').toEqual([]);
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
  expect(unsafe.original.safe).toBe(false);
  expect(unsafe.original.steps).toBeGreaterThan(0);
  const unknown = report.patterns.find((row) => row.source === '^[ab]*a[ab]{32}$')!;
  expect(unknown.original.safe).toBe(false);
  const safe = report.patterns.find((row) => row.source === '^A$')!;
  expect(safe.original.safe).toBe(true);
  // This is a test observation of the proposed method, not a callable publication
  // API or a substitute HTTP verdict. Each pattern executes the real checker.
  // Vary the aggregate boundary by one checkpoint around the SAME native defect.
  for (const defect of [unsafe, exhaustion, unknown]) {
    const preceding = analyzePattern('!');
    expect(preceding.safe).toBe(true);
    const sorted = ['!', defect.source].sort();
    expect(sorted).toEqual(['!', defect.source]);
    for (const delta of [-1, 0, 1]) {
      const limit = preceding.steps + defect.original.steps + delta;
      let executed = 0;
      const observations: { source: string; safe: boolean; excess: boolean; steps: number }[] = [];
      for (const source of sorted) {
        const actual = analyzePattern(source);
        executed += actual.steps;
        observations.push({ source, safe: actual.safe, excess: executed > limit, steps: actual.steps });
        if (!actual.safe || executed > limit) break;
      }
      const last = observations.at(-1)!;
      expect(last.source).toBe(defect.source);
      expect(last.safe).toBe(false);
      expect(last.excess).toBe(delta < 0);
      expect(executed).toBeLessThanOrEqual(limit + 8193);
      console.log('same-pattern native boundary', JSON.stringify({ limit, delta, observations }));
    }
  }
  // Exercise a fixed candidate aggregate with actual sorted native executions,
  // including the costly defect after a safe prefix. No synthesized step debit.
  const sources = Array.from({ length: 900 }, (_, index) => `!${String(index).padStart(4, '0')}`);
  sources.push(exhaustion.source);
  let executed = 0;
  let reachedDefect = false;
  for (const source of [...new Set(sources)].sort()) {
    const actual = analyzePattern(source);
    executed += actual.steps;
    if (!actual.safe) {
      reachedDefect = source === exhaustion.source;
      break;
    }
    if (executed > candidateAnalysisMax) break;
  }
  expect(reachedDefect).toBe(true);
  expect(executed).toBeGreaterThan(candidateAnalysisMax);
  expect(executed).toBeLessThanOrEqual(candidateAnalysisMax + 8193);
  console.log('candidate aggregate native boundary', JSON.stringify({ executed, reachedDefect }));
}, 240_000);
