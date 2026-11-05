import { expect, test } from 'bun:test';
import { assertGrowth, type Bound, type GrowthSample, type Metric } from './growth-bound.ts';

const bounds = (rows: Bound): Record<Metric, Bound> => ({ rows, blocks: 'constant', statements: 'constant' });

const sample = (
  scale: number,
  rows: number,
  relation: string,
  repetitionRows = [rows],
  relationCount = 1,
): GrowthSample => ({
  scale,
  cost: {
    rows,
    blocks: 1,
    statements: 1,
    relations: Object.fromEntries(
      Array.from(
        { length: relationCount },
        (_, index) =>
          [
            `${relation}_${index}_${'x'.repeat(100)}`,
            { rows: rows + index, blocks: index + 1, sequentialScans: index === 0 ? 0 : 1 },
          ] as const,
      ),
    ),
  },
  repetitions: repetitionRows.map((value) => ({ rows: value, blocks: 1, statements: 1 })),
});

function failureMessage(samples: readonly GrowthSample[], bound: Bound): string {
  try {
    assertGrowth(samples, bounds(bound));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected the growth check to fail');
}

test('explains the violating window and bounds multi-window context', () => {
  const spike = failureMessage(
    [
      sample(1, 10, 'baseline_plan'),
      sample(8, 30, 'spike_plan', [29, 30]),
      sample(64, 11, 'recovered_plan'),
      sample(512, 12, 'unrelated_final_plan'),
    ],
    'constant',
  );
  expect(spike).toContain('window scales 1, 8, 64 values 10, 30, 11');
  expect(spike).toContain('maximum 30 at scale 8 minus baseline 10; observed +20 exceeds allowed +2');
  expect(spike).toContain('Scale 8 largest relations by rows: spike_plan');
  expect(spike).toContain('Scale 8 rows repetitions: [29, 30]');
  expect(spike).not.toContain('unrelated_final_plan');
  expect(spike).not.toContain('Scale 512');

  const step = failureMessage(
    [
      sample(1, 0, 'first', [0], 8),
      sample(8, 1, 'second', [1, 2, 3, 4, 5, 6, 7], 8),
      sample(64, 100, 'third', [100, 101, 102, 103, 104, 105, 106], 8),
      sample(512, 104, 'fourth', [104], 8),
      sample(4096, 1000, 'fifth', [1000], 8),
    ],
    'linear',
  );
  expect([...step.matchAll(/rows linear bound failed/g)]).toHaveLength(2);
  expect(step).toContain('second step from scale 8 to 64; observed +99 exceeds allowed +14');
  expect(step).toContain('second step from scale 512 to 4096; observed +896 exceeds allowed +58');
  expect(step).toContain('Scale 8 largest relations by rows:');
  expect(step).toContain('3 more omitted');
  expect(step).toContain('2 more omitted');
  expect(step.length).toBeLessThan(15000);
});
