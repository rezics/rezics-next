import { describe, expect, test } from 'bun:test';
import { effective, fixtureWork, oracle, sampleIds, tagParent } from './fixture';
import { percentile } from './graph-support';

describe('synthetic graph fixture and oracle', () => {
  test('same input yields stable unique relations and sparse tri-state override', () => {
    for (const size of [10_000, 50_000]) {
      const all = Array.from({ length: size }, (_, i) => fixtureWork(i, size));
      expect(all[0]).toEqual(fixtureWork(0, size));
      expect(all[0]!.related.length).toBeGreaterThan(100);
      expect(all.every(w => new Set(w.related).size === w.related.length)).toBe(true);
      expect(all.every(w => w.related.every(id => id >= 0 && id < size && id !== w.id))).toBe(true);
      expect(all.some(w => w.override === 'accept')).toBe(true);
      expect(all.some(w => w.override === 'reject')).toBe(true);
      expect(all.some(w => w.override === null)).toBe(true);
    }
  });

  test('realm reject masks baseline; accept overrides baseline; absent falls back', () => {
    expect(effective(fixtureWork(29, 10_000))).toBe(false);
    expect(effective(fixtureWork(31, 10_000))).toBe(true);
    expect(effective(fixtureWork(7, 10_000))).toBe(false);
    expect(effective(fixtureWork(1, 10_000))).toBe(true);
    const entries = oracle(10_000, sampleIds(10_000));
    expect(entries.every(e => e.parent === tagParent(e.tag))).toBe(true);
  });

  test('nearest rank percentiles retain cold sample separately', () => {
    expect(percentile([9, 1, 7, 3, 5], .5)).toBe(5);
    expect(percentile([9, 1, 7, 3, 5], .95)).toBe(9);
  });
});
