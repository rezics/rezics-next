import { expect, test } from 'bun:test';
import { growthViolations } from './growth-bound.ts';
import { costOf } from './growth-cost.ts';
import { medianCounted } from './growth-counters.ts';
import { checkedAdd, modelAdd, modelSum } from './growth-numeric.ts';

test('rounded model arithmetic accepts sub-ULP terms while exact arithmetic still detects lost contributions', () => {
  const subUlp = Number.EPSILON / 4;
  expect(modelAdd(1, subUlp, 'Regression term')).toBe(1);
  expect(modelSum([1, subUlp, -1], 'Normalized regression covariance')).toBe(subUlp);
  expect(() => checkedAdd(1, subUlp, 'Counted work')).toThrow(/loses a non-zero contribution/);
});

test('negative physical plan work is rejected before cost evidence exists', () => {
  expect(() =>
    costOf({
      statements: ['select value from app.items'],
      plans: [
        {
          'Query Text': 'select value from app.items',
          Plan: {
            'Node Type': 'Seq Scan',
            Schema: 'app',
            'Relation Name': 'items',
            'Actual Rows': -1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 0,
            'Shared Read Blocks': 0,
          },
        },
      ],
    }),
  ).toThrow();
});

test('negative growth measurements cannot satisfy constant bounds', () => {
  const samples = [1, 8, 64].map((scale) => ({ scale, cost: { rows: -1, blocks: 0, statements: 0 } }));
  expect(() => growthViolations(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' })).toThrow();
});

test('a missing counted repetition cannot become an unreported NaN median', () => {
  expect(() => medianCounted([{ examined: 1 }, {}, { examined: 3 }])).toThrow();
});
