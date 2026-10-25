import { expect, test } from 'bun:test';
import { assertGrowth, GrowthBoundError, growthViolations, type Bound, type GrowthSample, type Metric } from './growth-bound.ts';

const metrics: readonly Metric[] = ['rows', 'blocks', 'statements'];
const allBounds = (bound: Bound): Record<Metric, Bound> => ({ rows: bound, blocks: bound, statements: bound });
const series = (scales: readonly [number, number, number], values: readonly [number, number, number]): GrowthSample[] =>
  scales.map((scale, index) => ({ scale, cost: { rows: values[index]!, blocks: values[index]!, statements: values[index]! } }));

for (const scales of [[1, 8, 64], [2, 16, 128]] as const) {
  test(`accepts constant, logarithmic and linear series at scales ${scales.join(', ')}`, () => {
    const constant = series(scales, [7, 7, 8]);
    const logarithmic = series(scales, scales.map((x) => 3 + 2 * Math.log2(x)) as [number, number, number]);
    const linear = series(scales, scales.map((x) => 10 * x) as [number, number, number]);
    expect(growthViolations(constant, allBounds('constant'))).toEqual([]);
    expect(growthViolations(logarithmic, allBounds('logarithmic'))).toEqual([]);
    expect(growthViolations(linear, allBounds('linear'))).toEqual([]);
  });
}

test('rejects linear growth declared logarithmic and power growth faster than a cube root', () => {
  const scales = [1, 8, 64] as const;
  expect(growthViolations(series(scales, scales), allBounds('logarithmic'))).toHaveLength(3);
  expect(growthViolations(series(scales, scales.map((x) => Math.sqrt(x)) as [number, number, number]), allBounds('logarithmic'))).toHaveLength(3);
});

test('rejects quadratic growth declared linear', () => {
  const scales = [1, 8, 64] as const;
  expect(growthViolations(series(scales, scales.map((x) => x * x) as [number, number, number]), allBounds('linear'))).toHaveLength(3);
});

test('rejects any growth beyond slack for a constant bound', () => {
  expect(growthViolations(series([1, 8, 64], [7, 10, 11]), allBounds('constant'))).toHaveLength(3);
});

test('absorbs one B-tree level of growth in blocks under default slack', () => {
  const samples: GrowthSample[] = [30, 30, 40].map((blocks, index) => ({
    scale: [1, 8, 64][index]!,
    cost: { rows: 1, blocks, statements: 1 },
  }));
  expect(growthViolations(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' })).toEqual([]);
  expect(growthViolations(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' })).toEqual([]);
});

test('requires three increasing scales with an equal ratio of at least four', () => {
  for (const scales of [[1, 8], [1, 8, 32], [1, 4, 16.1], [1, 3, 9], [1, 8, 63]] as number[][]) {
    expect(() => growthViolations(scales.map((scale) => ({ scale, cost: { rows: 1, blocks: 1, statements: 1 } })), allBounds('constant'))).toThrow(TypeError);
  }
  expect(() => growthViolations(series([1, 8, 64], [1, Number.NaN, 1]), allBounds('constant'))).toThrow(TypeError);
});

test('names the metric, values and largest relations in the error', () => {
  const samples = series([1, 8, 64], [1, 8, 64]).map((sample, index) => ({
    ...sample,
    cost: {
      ...sample.cost,
      relations: index === 2 ? {
        small_table: { rows: 5, blocks: 2 },
        largest_rows: { rows: 100, blocks: 3 },
        largest_blocks: { rows: 4, blocks: 90 },
      } : undefined,
    },
  }));
  let error: unknown;
  try {
    assertGrowth(samples, { rows: 'logarithmic', blocks: 'constant', statements: 'constant' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GrowthBoundError);
  expect((error as Error).message).toContain('rows');
  expect((error as Error).message).toContain('1, 8, 64');
  expect((error as Error).message).toContain('largest_rows');
  expect((error as Error).message).toContain('largest_blocks');
});
