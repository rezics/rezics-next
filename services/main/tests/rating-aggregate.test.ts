import { expect, test } from 'bun:test';
import { EXPERIENCE_AGGREGATE_PROFILES, reduceExperienceRatings,
  type EffectiveExperience } from '../src/modules/rating/experience-reduction.ts';

const [latest, perRater, pooled] = EXPERIENCE_AGGREGATE_PROFILES;
function observations(values: (number | null)[], raterKey = 'A'): EffectiveExperience[] {
  return values.map((value, i) => ({ value, raterKey, observation: `${raterKey}-${i}`,
    evaluatedAt: `2026-09-26T10:00:0${i}.000Z` }));
}
const precision = (numerator: string, denominator: string) => ({ kind: 'exact-rational' as const, numerator, denominator });

test('RATE01: separately labeled exact reductions preserve rater and observation denominators', () => {
  const data = [...observations([2, 2, 8]), ...observations([6], 'B')];
  const results = EXPERIENCE_AGGREGATE_PROFILES.map(profile => reduceExperienceRatings(profile, data));
  expect(results.map(result => result.mean)).toEqual([7, 5, 4.5]);
  expect(results.map(result => result.count)).toEqual([2, 2, 4]);
  expect(results.map(result => result.denominatorUnit)).toEqual(['rater', 'rater', 'observation']);
  expect(results.map(result => result.distribution.unit)).toEqual(['rater', 'rater', 'observation']);
  expect(results.map(result => result.precision)).toEqual([precision('7', '1'), precision('5', '1'), precision('9', '2')]);
  expect(results.map(result => result.aggregationPolicy)).toEqual(['latest-per-rater-mean', 'mean-per-rater', 'pooled-observation-mean']);
  expect(results.map(result => result.distribution.points)).toEqual([
    [{ numerator: '6', denominator: '1', count: 1 }, { numerator: '8', denominator: '1', count: 1 }],
    [{ numerator: '4', denominator: '1', count: 1 }, { numerator: '6', denominator: '1', count: 1 }],
    [{ numerator: '2', denominator: '1', count: 2 }, { numerator: '6', denominator: '1', count: 1 }, { numerator: '8', denominator: '1', count: 1 }],
  ]);
  for (const result of results) {
    expect(result.population).toEqual({ observations: 4, raters: 2, availableObservations: 4,
      withdrawnObservations: 0, contributingRaters: 2 });
    expect(result.observationHistogram).toEqual([0, 2, 0, 0, 0, 1, 0, 1, 0, 0]);
  }
});

test('RATE01/RATE04: latest selection includes tombstones and deterministic evaluation ties', () => {
  const data = [...observations([2, 2, null]), ...observations([6], 'B')];
  expect(reduceExperienceRatings(latest, data).mean).toBe(6);
  expect(reduceExperienceRatings(perRater, data).mean).toBe(4);
  expect(reduceExperienceRatings(pooled, data).precision).toEqual(precision('10', '3'));
  const tied = observations([2, null]).map(value => ({ ...value, evaluatedAt: '2026-09-26T10:00:00.000Z' }));
  expect(reduceExperienceRatings(latest, tied).precision).toEqual({ kind: 'no-data' });
  expect(reduceExperienceRatings(latest, [...tied].reverse())).toEqual(reduceExperienceRatings(latest, tied));
});

test('RATE01: rational distributions retain noninteger rater means and empty populations', () => {
  const data = [...observations([1, 2, 2]), ...observations([9, 10], 'B')];
  const result = reduceExperienceRatings(perRater, data);
  expect(result.sum).toEqual({ numerator: '67', denominator: '6' });
  expect(result.precision).toEqual(precision('67', '12'));
  expect(result.distribution.points).toEqual([
    { numerator: '5', denominator: '3', count: 1 }, { numerator: '19', denominator: '2', count: 1 },
  ]);
  expect(reduceExperienceRatings(perRater, [...data].reverse())).toEqual(result);
  for (const profile of EXPERIENCE_AGGREGATE_PROFILES) {
    expect(reduceExperienceRatings(profile, [])).toMatchObject({ count: 0, mean: null,
      sum: { numerator: '0', denominator: '1' }, precision: { kind: 'no-data' },
      distribution: { points: [] }, timeBasis: { evaluatedRange: null } });
    expect(reduceExperienceRatings(profile, observations([null, null]))).toMatchObject({
      count: 0, mean: null, population: { observations: 2, raters: 1, withdrawnObservations: 2 } });
  }
});
