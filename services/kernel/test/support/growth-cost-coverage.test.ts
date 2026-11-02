import { expect, test } from 'bun:test';
import { medianCost, type Cost } from './growth-cost.ts';

function cost(fields: Partial<Cost> = {}): Cost {
  return {
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 0,
    rows: 0,
    blocks: 0,
    sharedHit: 0,
    sharedRead: 0,
    relations: {},
    ...fields,
  };
}

test('preserves missing telemetry when aggregating growth repetitions', () => {
  const absentBytes = medianCost([cost(), cost()]);
  expect(absentBytes).not.toHaveProperty('requestBytes');
  expect(absentBytes).not.toHaveProperty('responseBytes');
  expect(medianCost([cost({ requestBytes: 0 }), cost({ requestBytes: 8 })])).toHaveProperty('requestBytes', 0);
  expect(() => medianCost([cost({ requestBytes: 8 }), cost()])).toThrow(
    /requestBytes.*present in repetitions 0.*missing in repetitions 1/,
  );

  const noExecution = cost({ statements: 0 });
  expect(medianCost([cost({ requestBytes: 8 }), noExecution])).toHaveProperty('requestBytes', 0);
  expect(medianCost([cost({ backgroundStatements: 1 }), cost({ backgroundStatements: 1 })])).not.toHaveProperty(
    'backgroundRows',
  );
  expect(() =>
    medianCost([cost({ backgroundStatements: 1, backgroundRows: 2 }), cost({ backgroundStatements: 1 })]),
  ).toThrow(/backgroundRows/);

  expect(
    medianCost([
      cost({
        backgroundStatements: 2,
        backgroundRequestBytes: 12,
        backgroundRows: 8,
        backgroundBlocks: 3,
        backgroundCosts: { vacuum: { rows: 8, blocks: 3, bounded: true } },
      }),
      cost({ backgroundStatements: 0, backgroundRows: 0, backgroundBlocks: 0, backgroundCosts: {} }),
    ]),
  ).toMatchObject({ backgroundStatements: 0, backgroundRequestBytes: 0, backgroundRows: 0, backgroundBlocks: 0 });
});
