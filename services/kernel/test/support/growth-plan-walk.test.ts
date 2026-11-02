import { expect, test } from 'bun:test';
import { costOf } from './growth-cost.ts';
import { MAX_PLAN_DEPTH, MAX_PLAN_NODES } from './growth-plan-walk.ts';
import { statementAttributions, statementOccurrences } from './growth-report.ts';

function node(fields: Record<string, unknown> = {}, children?: unknown[]) {
  return {
    'Node Type': 'Result',
    'Actual Rows': 0,
    'Actual Loops': 1,
    'Shared Hit Blocks': 0,
    'Shared Read Blocks': 0,
    ...fields,
    ...(children === undefined ? {} : { Plans: children }),
  };
}

function capture(plan: unknown) {
  return { statements: ['select 1'], plans: [{ 'Query Text': 'select 1', Plan: plan }] };
}

function chain(edges: number) {
  const root = node();
  let current = root;
  for (let index = 0; index < edges; index++) {
    const child = node();
    current.Plans = [child];
    current = child;
  }
  return root;
}

test('cost and diagnostics reject cyclic and malformed plan children with their location', () => {
  const cycle = node();
  cycle.Plans = [cycle];
  const sparse: unknown[] = new Array(1);
  const invalid = [cycle, node({}, sparse), node({}, [null]), node({ Plans: null })];

  for (const plan of invalid) {
    expect(() => costOf(capture(plan))).toThrow(/plans\[0\]\.Plan\.Plans/);
    expect(() => statementOccurrences(capture(plan))).toThrow(/plans\[0\]\.Plan\.Plans/);
  }
});

test('plan traversal enforces documented depth and node limits', () => {
  expect(() => statementOccurrences(capture(chain(MAX_PLAN_DEPTH + 1)))).toThrow(/maximum depth 256/);
  expect(() =>
    costOf(capture(node({}, Array.from({ length: MAX_PLAN_NODES }, () => node())))),
  ).toThrow(/maximum node count 10000/);
});

test('valid plan costs and statement diagnostics retain their measured descendants', () => {
  const plan = node({}, [
    node(
      {
        'Node Type': 'Seq Scan',
        Schema: 'app',
        'Relation Name': 'items',
        'Actual Rows': 3,
        'Shared Hit Blocks': 3,
      },
    ),
  ]);
  const sample = capture(plan);

  expect(costOf(sample)).toMatchObject({ rows: 3, blocks: 3, relations: { 'app.items': { rows: 3 } } });
  expect(statementOccurrences(sample).statements[0]).toMatchObject({ rows: 3, blocks: 3 });
  expect(statementAttributions(sample)[0]).toMatchObject({ rows: 3, blocks: 3, node: 'Seq Scan app.items' });
});
