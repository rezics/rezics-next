import { expect, test } from 'bun:test';
import { costOf, medianCost } from './growth-cost.ts';

type PlanNode = Record<string, unknown>;

function node(
  type: string,
  hit: number,
  options: { readonly producer?: string; readonly scan?: string; readonly plans?: PlanNode[] } = {},
): PlanNode {
  return {
    'Node Type': type,
    'Actual Rows': 0,
    'Actual Loops': 1,
    'Shared Hit Blocks': hit,
    'Shared Read Blocks': 0,
    ...(options.producer === undefined ? {} : { 'Subplan Name': `CTE ${options.producer}` }),
    ...(options.scan === undefined ? {} : { 'CTE Name': options.scan }),
    ...(options.plans === undefined ? {} : { Plans: options.plans }),
  };
}

function cost(root: PlanNode) {
  return costOf({ statements: [], plans: [{ Plan: root }] });
}

test('nested CTEs reusing a name keep each producer paired with its own scans', () => {
  const nestedScope = node('Result', 20, {
    plans: [
      node('Result', 10, { producer: 'items' }),
      node('CTE Scan', 10, { scan: 'items' }),
      node('CTE Scan', 10, { scan: 'items' }),
    ],
  });
  const result = cost(node('Result', 0, { plans: [node('Result', 100, { producer: 'items', plans: [nestedScope] })] }));

  expect(result.sharedHit).toBe(100);
});

test('shared scans account for a producer once and unmatched scans remain visible', () => {
  const shared = cost(
    node('Result', 12, {
      plans: [
        node('Result', 12, { producer: 'items' }),
        node('CTE Scan', 6, { scan: 'items' }),
        node('CTE Scan', 6, { scan: 'items' }),
      ],
    }),
  );
  expect(shared.sharedHit).toBe(12);

  const unmatched = cost(node('Result', 7, {
    plans: [node('Result', 20, { producer: 'items' }), node('CTE Scan', 7, { scan: 'other' })],
  }));
  expect(unmatched.sharedHit).toBe(27);
  expect(medianCost([unmatched]).limitations).toEqual(unmatched.limitations);
  expect(unmatched.limitations).toHaveLength(1);
});
