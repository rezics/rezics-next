import { expect, test } from 'bun:test';
import { classifySeries, type GrowthModelBound, type SeriesPoint } from './growth-model.ts';

function series(scales: readonly number[], medians: readonly number[], uncertainty = 0): SeriesPoint[] {
  return scales.map((scale, index) => ({
    scale,
    repetitions: [medians[index]!, medians[index]!, medians[index]!],
    uncertainty,
  }));
}

function boundsFor(scales: readonly number[], medians: readonly number[], bound: GrowthModelBound) {
  return classifySeries(series(scales, medians), bound);
}

test('a series is compatible with a declared bound when some allowed family places every median within its uncertainty', () => {
  const constant = classifySeries(series([1, 4, 16], [15, 15, 23], 4), 'constant');
  expect(constant.outcome).toBe('compatible');
  expect(constant.medians).toEqual([15, 15, 23]);
  expect(constant.intervals).toEqual([
    { lower: 11, upper: 19 },
    { lower: 11, upper: 19 },
    { lower: 19, upper: 27 },
  ]);
  expect(constant.adjacentDifferences).toEqual([0, 8]);
  expect(constant.families.constant.factor).toBeCloseTo(1, 8);

  const fiveScales = [1, 4, 16, 64, 256];
  const logSlope = 2 / Math.log(4);
  const staircase = fiveScales.map((scale) => 10 + logSlope * Math.log(scale));
  expect(boundsFor(fiveScales, staircase, 'logarithmic').outcome).toBe('compatible');
  expect(boundsFor(fiveScales, staircase, 'constant').outcome).toBe('violation');

  const threeScales = [1, 4, 16];
  const linear = threeScales.map((scale) => 7 + 3 * (scale - 1));
  expect(boundsFor(threeScales, linear, 'linear').outcome).toBe('compatible');
  expect(boundsFor(threeScales, linear, 'logarithmic').outcome).toBe('violation');

  expect(boundsFor([1, 4, 16], [15, 15, 15], 'constant').outcome).toBe('compatible');
  const exactMismatch = boundsFor([1, 4, 16], [15, 15, 16], 'constant');
  expect(exactMismatch.outcome).toBe('violation');
  expect(exactMismatch.families.constant.factor).toBe(Number.POSITIVE_INFINITY);
});

test("a series no allowed family fits is a violation with each family's fit and the adjacent differences", () => {
  const beyondConstant = classifySeries(series([1, 4, 16], [15, 15, 23], 3), 'constant');
  expect(beyondConstant.outcome).toBe('violation');
  expect(beyondConstant.families.constant.factor).toBeGreaterThan(1);
  expect(beyondConstant.adjacentDifferences).toEqual([0, 8]);
  expect(Object.keys(beyondConstant.families).toSorted()).toEqual(['constant', 'linear', 'logarithmic']);
  for (const family of Object.values(beyondConstant.families)) {
    expect(Number.isFinite(family.a)).toBe(true);
    expect(Number.isFinite(family.b)).toBe(true);
    expect(family.residuals).toHaveLength(3);
    expect(typeof family.factor).toBe('number');
  }

  const lowCountsWithLargeValues = classifySeries(
    series([1, 4, 16, 64, 256], [2, 2, 3, 1_000_000, 1_000_000]),
    'linear',
  );
  expect(lowCountsWithLargeValues.outcome).toBe('violation');
  expect(lowCountsWithLargeValues.adjacentDifferences).toEqual([0, 1, 999_997, 0]);
  expect(Object.values(lowCountsWithLargeValues.families).every(({ factor }) => factor === Infinity)).toBe(true);
});

test('a compatible median fit passes even when one repetition varies beyond uncertainty', () => {
  const result = classifySeries(
    [
      { scale: 1, repetitions: [10, 10, 10], uncertainty: 5 },
      { scale: 2, repetitions: [20, 20, 20], uncertainty: 5 },
      { scale: 3, repetitions: [30, 30, 41], uncertainty: 5 },
    ],
    'linear',
  );

  expect(result.medians).toEqual([10, 20, 30]);
  expect(result.families.linear.factor).toBe(0);
  expect(result.outcome).toBe('compatible');
});

test('a feasible family fit stays compatible when its slope interval has room', () => {
  const scales = [1, 4, 16, 64, 256];
  const points = scales.map((scale) => {
    const value = 100 + 1000 * (scale - 1);
    return { scale, repetitions: [value, value, value], uncertainty: value * 0.95 };
  });

  expect(classifySeries(points, 'logarithmic').outcome).toBe('compatible');
});

test('an index staircase admits bounded level changes on top of an allowed family and reports its values', () => {
  const scales = [1, 4, 16, 64];
  const values = [10, 11, 13, 14];
  const result = classifySeries(series(scales, values), 'logarithmic', 2);
  expect(result.outcome).toBe('compatible');
  expect(result.staircase).toHaveLength(scales.length);
  expect(result.staircase[0]).toBe(0);
  expect(result.staircase.some((value) => value > 0)).toBe(true);
  for (let index = 1; index < result.staircase.length; index += 1) {
    const rise = result.staircase[index]! - result.staircase[index - 1]!;
    expect(rise).toBeGreaterThanOrEqual(0);
    expect(rise).toBeLessThanOrEqual(2);
  }

  const exceedsProbeRise = classifySeries(series([1, 4, 16], [10, 20, 20]), 'logarithmic', 2);
  expect(exceedsProbeRise.outcome).toBe('violation');
  const falls = classifySeries(series([1, 4, 16], [20, 10, 5]), 'logarithmic', 2);
  expect(falls.outcome).toBe('compatible');
  const unexplained = classifySeries(series([1, 4, 16, 64], [10, 10, 22, 22]), 'logarithmic', 2);
  expect(unexplained.outcome).toBe('violation');
});

test('zero and fractional work remain valid model evidence', () => {
  const zero = classifySeries(series([1, 4, 16], [0, 0, 0]), 'constant');
  expect(zero.outcome).toBe('compatible');
  expect(zero.medians).toEqual([0, 0, 0]);

  const fractional = classifySeries(
    [
      { scale: 1, repetitions: [0.5, 0.5], uncertainty: 0 },
      { scale: 4, repetitions: [1, 1], uncertainty: 0 },
      { scale: 16, repetitions: [1.5, 1.5], uncertainty: 0 },
    ],
    'linear',
  );
  expect(fractional.medians).toEqual([0.5, 1, 1.5]);
  expect(fractional.adjacentDifferences).toEqual([0.5, 0.5]);
  expect(fractional.outcome).toBe('compatible');
});

test('series arithmetic preserves a representable large regression and a negative diagnostic intercept', () => {
  const maximum = Number.MAX_VALUE;
  const largeValues = [maximum / 4, maximum / 2, (maximum / 4) * 3];
  expect(largeValues.every(Number.isFinite)).toBe(true);
  const large = classifySeries(series([1, 2, 3], largeValues), 'linear');
  expect(large.outcome).toBe('compatible');
  expect(large.medians).toEqual(largeValues);
  expect(Number.isFinite(large.families.linear.a)).toBe(true);
  expect(Number.isFinite(large.families.linear.b)).toBe(true);

  const negativeIntercept = classifySeries(series([1, 4, 16], [0, 1, 100]), 'linear');
  expect(negativeIntercept.families.linear.a).toBeLessThan(0);
  expect(Number.isFinite(negativeIntercept.families.linear.a)).toBe(true);
});

test('series classification rejects non-finite measurements before fitting', () => {
  const maximum = Number.MAX_VALUE;
  expect(() =>
    classifySeries(series([1, 2, 3], [maximum / 4, maximum / 2, Number.POSITIVE_INFINITY]), 'linear'),
  ).toThrow(/finite number/);
});

test('series classification requires three to five scales before fitting or staircase elimination', () => {
  for (const points of [series([1, 4], [10, 20]), series([1, 4, 16, 64, 256, 1024], [10, 20, 30, 40, 50, 60])]) {
    expect(() => classifySeries(points, 'linear', 2)).toThrow(/three to five scales/);
  }
});

test('series classification refuses overflowed intervals, coordinates and regression fits', () => {
  const maximum = Number.MAX_VALUE;
  expect(() => classifySeries(series([1, 4, 16], [maximum, maximum, maximum], maximum), 'constant')).toThrow(
    /uncertainty upper bound/,
  );
  expect(() => classifySeries(series([Number.MIN_VALUE, 1, 2], [1, 1, 1]), 'linear')).toThrow(
    /Linear scale (ratio|coordinate)/,
  );
  expect(() =>
    classifySeries(series([1, 1 + Number.EPSILON, 1 + Number.EPSILON * 2], [0, maximum, maximum]), 'linear'),
  ).toThrow(/Regression slope/);
  const sparseRepetitions = [1, , 1] as number[];
  expect(() =>
    classifySeries(
      [
        { scale: 1, repetitions: [1], uncertainty: 0 },
        { scale: 4, repetitions: sparseRepetitions, uncertainty: 0 },
        { scale: 16, repetitions: [1], uncertainty: 0 },
      ],
      'constant',
    ),
  ).toThrow(/missing item 2/);
});

test('finite uncertainty keeps legitimate unbounded slope ranges feasible', () => {
  const result = classifySeries(
    [1, 1 + Number.EPSILON, 1 + Number.EPSILON * 2].map((scale) => ({
      scale,
      repetitions: [0, 0, 0],
      uncertainty: Number.MAX_VALUE,
    })),
    'linear',
  );
  expect(result.outcome).toBe('compatible');
  expect(result.intervals.at(-1)).toEqual({ lower: 0, upper: Number.MAX_VALUE });
});
