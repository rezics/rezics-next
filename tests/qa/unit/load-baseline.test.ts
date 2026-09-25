import { describe, expect, test } from 'bun:test';
import { combineLoadCorpus, validateLoadBaseline, type LoadBaseline }
  from '../../../scripts/load/baseline.ts';
import { uniqueToken, type PracticalCorpus } from '../../../scripts/load/corpus.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function corpus(start: number, count: number): PracticalCorpus {
  const works = Array.from({ length: count }, (_, local) => {
    const index = start + local;
    return { work: id(index + 1), main: id(index + 10_001), head: id(index + 20_001),
      selection: id(index + 30_001), createReceipt: `urn:rezics:receipt:${index}-create`,
      selectionReceipt: `urn:rezics:receipt:${index}-selection`, token: uniqueToken(index),
      language: index % 101 === 7 ? 'zh' : index % 137 === 9 ? 'ja' : 'en' };
  });
  return { realm: id(start + 40_001), ratingContext: id(start + 50_001), works,
    mainUnits: count + 1, contentUnits: 1,
    cases: ['hot-main', 'other-main', 'chinese-main', 'realm-adoption', 'realm-fallback',
      'rejected-candidate', 'content'].map(name => ({ name, lane: 'main' as const,
        phrase: works[0]!.token, language: 'en', expectedWork: works[0]!.work })) };
}
function baseline(): LoadBaseline {
  return { version: 1, runId: 'load-test', works: 90, corpus: corpus(0, 90), actor: id(60_001),
    graphSequence: '443', contentPosition: { dataEpoch: '00000000-0000-4000-8000-000000000001',
      sequence: '3' },
    indexGeneration: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000002',
    baselineGrantsExpired: true };
}

describe('load baseline provenance and fresh cohort', () => {
  test('requires exact source and population', () => {
    const saved = baseline();
    expect(validateLoadBaseline(saved, 'load-test', 90)).toEqual(saved);
    expect(() => validateLoadBaseline(saved, 'load-other', 90)).toThrow();
    expect(() => validateLoadBaseline(saved, 'load-test', 91)).toThrow();
    saved.corpus.works[4]!.token = saved.corpus.works[3]!.token;
    expect(() => validateLoadBaseline(saved, 'load-test', 90)).toThrow();
  });

  test('puts fresh writable Works on both sides of the read-only background', () => {
    const old = baseline().corpus;
    const fresh = corpus(90, 10);
    const joined = combineLoadCorpus(old, fresh, 100);
    expect(joined.works).toHaveLength(100);
    expect(joined.writableIndices).toEqual([0, 1, 2, 3, 4, 95, 96, 97, 98, 99]);
    expect(joined.works[5]).toBe(old.works[0]);
    expect(joined.works[94]).toBe(old.works[89]);
    expect(joined.mainUnits).toBe(102);
    expect(joined.contentUnits).toBe(2);
    expect(() => combineLoadCorpus(old, fresh, 101)).toThrow();
  });
});
