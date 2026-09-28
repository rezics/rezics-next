import { expect, test } from 'bun:test';
import { baselineTarget } from '../src/modules/access/baseline.ts';
import { conceptLabel, conceptScopePattern, matchesConceptLabel, ConceptSearchInvalid }
  from '../src/modules/semantic/concept-search.ts';

test('G-354 label lookup preserves CJK substring, width equivalence and language boundaries', () => {
  expect(matchesConceptLabel('真後宮', '後宮')).toBe(true);
  expect(matchesConceptLabel('ｶﾀｶﾅ ＡＢＣ', 'カタカナ abc')).toBe(true);
  expect(matchesConceptLabel('京都の物語', '東京')).toBe(false);
  expect(conceptLabel('  中文 Ａ  ', 'ZH-Hant')).toEqual({ label: '中文 A', language: 'zh-hant' });
  for (const value of ['', ' ', 'x\u0000y', 'x\u202Ey', '界'.repeat(121)]) {
    expect(() => conceptLabel(value, 'zh')).toThrow(ConceptSearchInvalid);
  }
  expect(() => conceptLabel('tag', 'en" . ?s ?p ?o')).toThrow(ConceptSearchInvalid);
  expect(() => conceptLabel('tag', 'zh-x')).toThrow(ConceptSearchInvalid);
  expect(() => conceptScopePattern('https://rezics.com/id/x>')).toThrow(ConceptSearchInvalid);
});

test('G-354 author proposals add only the Work-bound Statement admission, never curator grants', () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  expect(baselineTarget('statement.record', `work:edit:${work}`)).toEqual({ kind: 'author-work', id: work });
  expect(baselineTarget('statement.record', 'work:edit:all')).toBeNull();
  expect(baselineTarget('classification.proposition.define', 'classification:define:global')).toBeNull();
  expect(baselineTarget('statement.decide', 'classification:decide:global')).toBeNull();
  expect(baselineTarget('statement.decide', `classification:decide:${work}`)).toBeNull();
  expect(baselineTarget('publication.adopt', `publication:adopt:${work}`)).toBeNull();
});
