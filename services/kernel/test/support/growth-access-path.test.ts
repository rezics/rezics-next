import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, type AccessPathSample } from './growth-access-path.ts';
import type { Cost } from './growth-cost.ts';

const relation = 'content.report';
function cost(scans: number): Cost {
  return {
    rows: 68,
    blocks: 2,
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    sharedHit: 2,
    sharedRead: 0,
    relations: { [relation]: { rows: 68, blocks: 2, nodes: 1, sequentialScans: scans } },
  };
}
function sample(pages: number, scans: readonly number[] = [1]): AccessPathSample {
  return {
    scale: 32,
    relationSizes: { [relation]: { reltuples: 68, relpages: pages } },
    repetitions: scans.map(cost),
  };
}
test('measured footprints through eight pages leave all scan work for the growth series', () => {
  const samples = [sample(2), sample(8)];
  const before = JSON.stringify(samples);
  expect(() => assertGrowthAccessPaths('small path', samples, [relation])).not.toThrow();
  expect(JSON.stringify(samples)).toBe(before);
  expect(samples[0]!.repetitions[0]!.relations[relation]).toEqual({
    rows: 68,
    blocks: 2,
    nodes: 1,
    sequentialScans: 1,
  });
});
test('nine pages require zero executed scans and an index path remains eligible', () => {
  expect(() => assertGrowthAccessPaths('large path', [sample(9)], [relation])).toThrow();
  expect(() => assertGrowthAccessPaths('large path', [sample(9, [0])], [relation])).not.toThrow();
});
test('a bad nonrepresentative repetition cannot disappear behind a median', () => {
  const samples = [sample(9, [0, 1, 0])];
  const before = JSON.stringify(samples);
  expect(() => assertGrowthAccessPaths('all runs', samples, [relation])).toThrow();
  expect(JSON.stringify(samples)).toBe(before);
});
test('missing or invalid relation footprint is never treated as a tiny table', () => {
  expect(() => assertGrowthAccessPaths('missing pages', [{ ...sample(2), relationSizes: {} }], [relation])).toThrow();
  for (const pages of [NaN, Infinity, -1, 8.5])
    expect(() => assertGrowthAccessPaths('invalid pages', [sample(pages)], [relation])).toThrow();
});
