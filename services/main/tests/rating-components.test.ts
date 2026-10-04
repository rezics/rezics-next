import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { componentsAgree, meanDisclosure } from '../src/modules/rating/components.ts';
import { MAX_DISPLAY_THRESHOLD, effectiveDisplayThreshold, targetContextDigest }
  from '../src/modules/rating/target.ts';
import { scopedTargetRatingContextInput, targetRatingContextInput, targetAggregateResult }
  from '../src/modules/rating/target-api.ts';
import { precision } from '../src/modules/rating/target-aggregate.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const histogramOf = (...values: number[]) => {
  const histogram = Array.from({ length: 10 }, () => 0);
  for (const value of values) histogram[value - 1]!++;
  return { count: values.length, sum: values.reduce((a, b) => a + b, 0), histogram };
};

test('display threshold withholds the mean below it and reveals it exactly at it', () => {
  const four = histogramOf(8, 8, 9, 7), five = histogramOf(8, 8, 9, 7, 10);
  expect(meanDisclosure(four, 5)).toEqual({ mean: null, display: 'withheld-below-threshold' });
  expect(meanDisclosure(five, 5)).toEqual({ mean: 8.4, display: 'shown' });
  expect(meanDisclosure(four, 4)).toEqual({ mean: 8, display: 'shown' });
  expect(meanDisclosure(histogramOf(), 5)).toEqual({ mean: null, display: 'no-data' });
  // The count and histogram stay whatever the threshold says about the mean.
  expect(four.histogram).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 1, 0]);
});

test('default display threshold is 5, 10 for the projection grain, and a Context may override it', () => {
  for (const grain of ['release', 'realization', 'occurrence', 'resource']) {
    expect(effectiveDisplayThreshold(grain, null)).toBe(5);
  }
  expect(effectiveDisplayThreshold('projection', null)).toBe(10);
  expect(effectiveDisplayThreshold('resource', 2)).toBe(2);
  expect(effectiveDisplayThreshold('projection', 25)).toBe(25);
});

test('the display threshold override is an optional bounded integer of the v3 Context only', () => {
  const base = { profile: 'realm-target-rating-context-v3', realm: id(1), question: 'How good is this character?',
    language: 'en', targetGrain: 'resource', actingSubject: id(2) };
  expect(Value.Check(scopedTargetRatingContextInput, base)).toBe(true);
  expect(Value.Check(scopedTargetRatingContextInput, { ...base, displayThreshold: 1 })).toBe(true);
  expect(Value.Check(scopedTargetRatingContextInput, { ...base, displayThreshold: MAX_DISPLAY_THRESHOLD })).toBe(true);
  for (const bad of [0, -1, MAX_DISPLAY_THRESHOLD + 1, 2.5, '5']) {
    expect(Value.Check(scopedTargetRatingContextInput, { ...base, displayThreshold: bad })).toBe(false);
  }
  // v2 keeps its closed shape; v3 does not accept a grain it cannot create yet.
  expect(Value.Check(targetRatingContextInput, { ...base, profile: 'realm-target-rating-context-v2', displayThreshold: 5 })).toBe(false);
  expect(Value.Check(scopedTargetRatingContextInput, { ...base, targetGrain: 'projection' })).toBe(false);
});

test('a v3 request digest binds its threshold and never collides with v2', () => {
  const input = { realm: id(1), question: 'How good is this character?', language: 'en',
    targetGrain: 'resource' as const, actingSubject: id(2) };
  const digests = new Set([targetContextDigest(input), targetContextDigest({ ...input, scoped: true }),
    targetContextDigest({ ...input, scoped: true, displayThreshold: 3 }),
    targetContextDigest({ ...input, scoped: true, displayThreshold: 4 })]);
  expect(digests.size).toBe(4);
  expect(targetContextDigest({ ...input, scoped: true, displayThreshold: null })).toBe(targetContextDigest({ ...input, scoped: true }));
  expect(() => targetContextDigest({ ...input, scoped: true, displayThreshold: 0 })).toThrow();
  expect(() => targetContextDigest({ ...input, scoped: true, displayThreshold: MAX_DISPLAY_THRESHOLD + 1 })).toThrow();
});

test('additive components agree only when the count and sum are what the histogram says', () => {
  expect(componentsAgree(histogramOf(1, 10, 10, 5))).toBe(true);
  expect(componentsAgree(histogramOf())).toBe(true);
  expect(componentsAgree({ ...histogramOf(8, 8), sum: 17 })).toBe(false);
  expect(componentsAgree({ ...histogramOf(8, 8), count: 3 })).toBe(false);
  expect(componentsAgree({ count: 1, sum: 5, histogram: [0, 0, 0, 0, 1] })).toBe(false);
  expect(componentsAgree({ count: 1, sum: 5, histogram: [0, 0, 0, 0, 1.5, 0, 0, 0, 0, 0] })).toBe(false);
  expect(componentsAgree({ count: 0, sum: 0, histogram: [0, 0, 0, 0, -1, 1, 0, 0, 0, 0] })).toBe(false);
});

test('an aggregate response past the former 100-slot bound is a valid contract, with the mean withheld or shown', () => {
  const shown = histogramOf(...Array.from({ length: 150 }, (_, i) => (i % 10) + 1));
  const result = (figures: typeof shown, display: Parameters<typeof precision>[1]) => ({
    profile: 'realm-target-latest-mean-v1', complete: true, context: id(1), realm: id(2), target: id(3), targetGrain: 'resource',
    scope: { question: 'How good is this character?', language: 'en', grain: 'resource', population: 'account-principal', countedTarget: id(3) },
    scale: { min: 1, max: 10, step: 1 }, cadence: 'standing', populationPolicy: 'account-principal',
    aggregationPolicy: 'latest-per-rater-mean', population: 160, count: figures.count, withdrawnCount: 160 - figures.count,
    histogram: figures.histogram, sum: figures.sum, displayThreshold: 5, mean: display === 'shown' ? figures.sum / figures.count : null,
    meanDisplay: display, precision: precision(figures, display),
    sourcePosition: { datasetId: 'product', dataEpoch: 'e', sequence: '1' } });
  expect(Value.Check(targetAggregateResult, result(shown, 'shown'))).toBe(true);
  expect(Value.Check(targetAggregateResult, result(histogramOf(7, 7), 'withheld-below-threshold'))).toBe(true);
  expect(Value.Check(targetAggregateResult, result(histogramOf(), 'no-data'))).toBe(true);
  expect(precision(shown, 'shown')).toEqual({ kind: 'exact-rational', numerator: 825, denominator: 150 });
});
