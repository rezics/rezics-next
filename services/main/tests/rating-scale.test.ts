import { expect, test } from 'bun:test';
import { contextScale, ratingUnitsFromText, ratingUnitsText, exactRating, judgmentScale, onJudgmentScale, ratingTerm } from '../src/modules/rating/scale.ts';
import { reduceStandingComponent, synthesizeRealmGlobal } from '../src/modules/rating/synthesis.ts';
import { globalImportRating } from '../src/modules/library-import/apply.ts';
import { parseLibraryFile } from '../src/modules/library-import/formats/index.ts';

const stars = { min: 0.25, max: 5, step: 0.25 };
const votes = { min: 10, max: 100, step: 1 };

test('judgment grids validate exact offsets and retain the shared exact scalar representation', () => {
  expect(judgmentScale(stars)).toEqual(stars);
  expect(exactRating(4.75)).toEqual({ kind: 'decimal', lexical: '4.75' });
  expect(ratingTerm(4.75)).toBe('"4.75"^^<http://www.w3.org/2001/XMLSchema#decimal>');
  expect(exactRating(87)).toEqual({ kind: 'integer', lexical: '87' });
  expect(onJudgmentScale(4.75, stars)).toBe(true);
  expect(onJudgmentScale(4.6, stars)).toBe(false);
  expect(onJudgmentScale(0, stars)).toBe(false);
  expect(onJudgmentScale(5.25, stars)).toBe(false);
  expect(onJudgmentScale(0.3, { min: 0, max: 1, step: 0.1 })).toBe(true);
  expect(contextScale({ scaleMin: 1, scaleMax: 5 })).toEqual({ min: 1, max: 5, step: 1 });
  for (const invalid of [{ ...stars, step: 0 }, { ...stars, min: 5 }, { ...stars, step: 0.3 },
    { min: 0, max: 1, step: 0.000001 }]) expect(() => judgmentScale(invalid)).toThrow(RangeError);
});

test('fractional sums and mixed-scale normalization use exact arithmetic', () => {
  const a = reduceStandingComponent([4.75, null], stars);
  const b = reduceStandingComponent([87], votes);
  expect(a).toMatchObject({ scale: stars, sum: 4.75, count: 1, withdrawnCount: 1,
    precision: { kind: 'exact-rational', numerator: '19', denominator: '4' },
    unitMean: { numerator: '18', denominator: '19' } });
  expect(a.histogram).toHaveLength(20);
  expect(a.histogram[18]).toBe(1);
  expect(synthesizeRealmGlobal(a, b).value).toEqual({ numerator: '3083', denominator: '3420' });
  expect(reduceStandingComponent([0.1, 0.2], { min: 0, max: 1, step: 0.1 })).toMatchObject({
    sum: 0.3, precision: { kind: 'exact-rational', numerator: '3', denominator: '20' } });
  expect(() => reduceStandingComponent([4.6], stars)).toThrow(RangeError);
});

test('source imports require the same scale and retain VNDB and quarter-star precision', () => {
  const row = parseLibraryFile('vndb', '<vndb-export version="1.0"><vns><vn id="v17"><title>Source score</title><vote>8.7</vote></vn></vns></vndb-export>')[0]!;
  expect(globalImportRating(row)).toBeNull();
  expect(globalImportRating(row, { min: 1, max: 10, step: 0.1 })).toBe(8.7);
  expect(globalImportRating({ ...row, score: { value: 87, ...votes } }, votes)).toBe(87);
  expect(globalImportRating({ ...row, score: { value: 4.75, ...stars } }, stars)).toBe(4.75);
  expect(globalImportRating({ ...row, score: { value: 4.6, ...stars } }, stars)).toBeNull();
});

test('projection sums keep old integer weights and arbitrary-size decimal totals exact', () => {
  expect(ratingUnitsText(ratingUnitsFromText('9'))).toBe('9');
  expect(ratingUnitsText(ratingUnitsFromText('8.5') - ratingUnitsFromText('4.75'))).toBe('3.75');
  expect(ratingUnitsText(ratingUnitsFromText('9007199254740993.25') + ratingUnitsFromText('0.75')))
    .toBe('9007199254740994');
  expect(ratingUnitsText(-ratingUnitsFromText('4.75'))).toBe('-4.75');
});
