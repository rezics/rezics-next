import { expect, test } from 'bun:test';
import { JUDGMENT_POLICY, summarizeJudgments, wilson }
  from '../../../services/main/src/modules/judgment/policy.ts';

const empty = { fitNegative: 0, fitPositive: 0, spoilerNone: 0,
  spoilerMinor: 0, spoilerMajor: 0 };

test('GOV10: Wilson generation keeps one major vote protected with low confidence', () => {
  const one = summarizeJudgments({ ...empty, spoilerMajor: 1 });
  expect(one.policy).toEqual({ generation: 'wilson-v1', z: 1.96, defaultConceptHint: 'unknown' });
  expect(one.spoiler).toMatchObject({ protection: 'hide-major', status: 'major',
    confidence: 'low', sampleSize: 1,
    distribution: { notSpoiler: 0, minorSpoiler: 0, majorSpoiler: 1 } });
  expect(one.spoiler.bounds.major?.lower).toBeCloseTo(0.206543, 5);
  expect(one.spoiler.bounds.major?.upper).toBe(1);
  expect(wilson(0, 0)).toBeNull();
  expect(JUDGMENT_POLICY.z).toBe(1.96);
});

test('GOV10: no evidence uses the declared hint, while status remains unknown', () => {
  expect(summarizeJudgments(empty).spoiler).toMatchObject({ protection: 'hide-any',
    status: 'unknown', confidence: 'low', sampleSize: 0 });
  expect(summarizeJudgments(empty, 'major').spoiler.protection).toBe('hide-major');
  expect(summarizeJudgments(empty, 'not-spoiler').spoiler.protection).toBe('show-all');
});

test('GOV10: mixed unresolved votes are disputed; strong evidence has separate status', () => {
  const mixed = summarizeJudgments({ ...empty, spoilerNone: 1, spoilerMajor: 1 });
  expect(mixed.spoiler.status).toBe('disputed');
  expect(mixed.spoiler.protection).toBe('hide-major');
  expect(mixed.spoiler.distribution).toEqual({ notSpoiler: 1, minorSpoiler: 0, majorSpoiler: 1 });
  const strong = summarizeJudgments({ ...empty, spoilerNone: 40 });
  expect(strong.spoiler).toMatchObject({ status: 'not-spoiler', confidence: 'high',
    protection: 'show-all' });
  expect(strong.spoiler.bounds.none?.lower).toBeGreaterThan(0.5);
});

test('GOV09: fit and spoiler population sizes remain independent', () => {
  const result = summarizeJudgments({ ...empty, fitNegative: 1,
    spoilerMinor: 3, spoilerMajor: 1 });
  expect(result.fit.sampleSize).toBe(1);
  expect(result.spoiler.sampleSize).toBe(4);
  expect(result.fit.distribution).toEqual({ negative: 1, positive: 0 });
});
