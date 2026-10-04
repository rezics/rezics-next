import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { RANK_MINIMUM_RATINGS, MAX_ROLLUP_MEMBERS, memberFigure, rankMembers, rankingPrior, rollUp, weightedRating }
  from '../src/modules/rating/rollup.ts';
import { rollupInput } from '../src/modules/rating/rollup-api.ts';

/** `count` ratings averaging `mean`, as the additive components a roll-up reads. */
const members = (...pairs: [count: number, mean: number][]) => pairs.map(([count, mean]) => ({
  count, sum: count * mean, histogram: Array.from({ length: 10 }, (_, index) => index === Math.round(mean) - 1 ? count : 0) }));
const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// Simpson's paradox in the small: X is carried by one large, kind member; Y has two even ones.
const X = members([90, 7], [10, 3]), Y = members([10, 6], [10, 5]);

test('pooled and mean-of-means rank the same two roll-ups in opposite order', () => {
  const pooled = [X, Y].map(group => rollUp('pooled', group, 2, 5).value!);
  const means = [X, Y].map(group => rollUp('mean-of-means', group, 2, 5).value!);
  expect(pooled).toEqual([6.6, 5.5]);
  expect(means).toEqual([5, 5.5]);
  expect(pooled[0]! > pooled[1]!).toBe(true);
  expect(means[0]! < means[1]!).toBe(true);
});

test('pooled adds sums over counts of every readable member, mean-of-means counts only members at the threshold', () => {
  const group = members([20, 8], [2, 2]);
  expect(rollUp('pooled', group, 2, 5)).toMatchObject({ value: (160 + 4) / 22, valueWithheld: null,
    coverage: { members: 2, available: 2, meetingThreshold: 1 } });
  expect(rollUp('mean-of-means', group, 2, 5)).toMatchObject({ value: 8, valueWithheld: null });
  // The small member is a mean of two ratings: it is not averaged in below the threshold.
  expect(rollUp('mean-of-means', group, 2, 2).value).toBe(5);
});

test('the value is withheld when fewer than half of the named members reach the threshold', () => {
  const group = members([9, 8], [9, 7], [1, 10], [0, 0]);
  // Two of four members meet the threshold: exactly half covers.
  expect(rollUp('pooled', group, 4, 5)).toMatchObject({ value: (72 + 63 + 10) / 19, valueWithheld: null,
    coverage: { members: 4, available: 4, meetingThreshold: 2 } });
  expect(rollUp('pooled', group, 5, 5)).toMatchObject({ value: null, valueWithheld: 'coverage-below-half',
    coverage: { members: 5, available: 4, meetingThreshold: 2 } });
  expect(rollUp('mean-of-means', members([4, 8], [4, 9]), 2, 5)).toMatchObject({ value: null, valueWithheld: 'coverage-below-half',
    coverage: { members: 2, available: 2, meetingThreshold: 0 } });
});

test('members the caller cannot read stay in the denominator, so unreadable members lower coverage', () => {
  const readable = members([10, 9], [10, 9]);
  expect(rollUp('pooled', readable, 2, 5).valueWithheld).toBeNull();
  expect(rollUp('pooled', readable, 4, 5).valueWithheld).toBeNull();
  expect(rollUp('pooled', readable, 5, 5)).toMatchObject({ value: null, valueWithheld: 'coverage-below-half',
    coverage: { members: 5, available: 2, meetingThreshold: 2 } });
});

test("a member's own figure follows the same threshold as its page", () => {
  expect(memberFigure(members([4, 8])[0]!, 5)).toEqual({ mean: null, meanDisplay: 'withheld-below-threshold', meetsThreshold: false });
  expect(memberFigure(members([5, 8])[0]!, 5)).toEqual({ mean: 8, meanDisplay: 'shown', meetsThreshold: true });
  expect(memberFigure(members([0, 0])[0]!, 5)).toEqual({ mean: null, meanDisplay: 'no-data', meetsThreshold: false });
});

test('the ranking prior is the Context pooled mean weighted by its average ratings per target, never under the minimum', () => {
  expect(rankingPrior({ targets: 0, count: 0, sum: 0 })).toBeNull();
  expect(rankingPrior({ targets: 3, count: 0, sum: 0 })).toBeNull();
  expect(rankingPrior({ targets: 4, count: 100, sum: 600 })).toEqual({ mean: 6, weight: RANK_MINIMUM_RATINGS, ratings: 100, targets: 4 });
  expect(rankingPrior({ targets: 4, count: 1000, sum: 7000 })).toEqual({ mean: 7, weight: 250, ratings: 1000, targets: 4 });
});

test('weighted rating pulls a small sample toward the prior and leaves a large one near its own mean', () => {
  const prior = { mean: 6, weight: 50, ratings: 1000, targets: 10 };
  const [small, large] = members([50, 10], [5000, 10]);
  expect(weightedRating(small!, prior)).toBeCloseTo(8, 10);
  expect(weightedRating(large!, prior)).toBeCloseTo(10 * 5000 / 5050 + 6 * 50 / 5050, 10);
  expect(weightedRating(small!, prior) < weightedRating(large!, prior)).toBe(true);
});

test('a ranking lists only members of at least 50 ratings, best weighted rating first, ties by sample then target', () => {
  const prior = { mean: 6, weight: 50, ratings: 1000, targets: 10 };
  const [a, b, c, d, e] = members([49, 10], [50, 9], [500, 9], [60, 8], [60, 8]);
  const ranked = rankMembers([{ target: id(1), components: a! }, { target: id(2), components: b! },
    { target: id(3), components: c! }, { target: id(5), components: e! }, { target: id(4), components: d! }], prior);
  // id(1) has 49 ratings and is not listed however high its mean.
  expect(ranked.map(item => item.target)).toEqual([id(3), id(2), id(4), id(5)]);
  expect(ranked.map(item => item.position)).toEqual([1, 2, 3, 4]);
  expect(ranked[0]).toMatchObject({ count: 500, mean: 9 });
  expect(ranked[2]!.score).toBe(ranked[3]!.score);
});

test('a ranking can order members differently from their raw means', () => {
  const prior = { mean: 6, weight: 50, ratings: 5000, targets: 10 };
  const [few, many] = members([50, 9.5], [2000, 9.2]);
  const ranked = rankMembers([{ target: id(1), components: few! }, { target: id(2), components: many! }], prior);
  expect(ranked.map(item => item.target)).toEqual([id(2), id(1)]);
  expect(ranked[0]!.mean < ranked[1]!.mean).toBe(true);
});

test('a roll-up request names one Context, one to 200 distinct members and a known formula', () => {
  const base = { profile: 'rating-rollup-v1', context: id(1), targets: [id(2), id(3)], formula: 'pooled' };
  expect(Value.Check(rollupInput, base)).toBe(true);
  expect(Value.Check(rollupInput, { ...base, formula: 'mean-of-means', rank: true })).toBe(true);
  expect(Value.Check(rollupInput, { ...base, formula: 'median' })).toBe(false);
  expect(Value.Check(rollupInput, { ...base, targets: [] })).toBe(false);
  expect(Value.Check(rollupInput, { ...base, targets: [id(2), id(2)] })).toBe(false);
  expect(Value.Check(rollupInput, { ...base, targets: Array.from({ length: MAX_ROLLUP_MEMBERS }, (_, i) => id(i + 10)) })).toBe(true);
  expect(Value.Check(rollupInput, { ...base, targets: Array.from({ length: MAX_ROLLUP_MEMBERS + 1 }, (_, i) => id(i + 10)) })).toBe(false);
  // Neither another Context nor a stored mean can ride along.
  expect(Value.Check(rollupInput, { ...base, contexts: [id(9)] })).toBe(false);
  expect(Value.Check(rollupInput, { ...base, mean: 7 })).toBe(false);
});
