import { expect, test } from 'bun:test';
import { admitAggregatedCaptures } from './growth-capture-evidence.ts';
import { catalogStatementBound, costOf, type Capture } from './growth-cost.ts';
import { mergeGrowthCaptures } from './growth-capture-merge.ts';
import { statementAttributions, statementOccurrences } from './growth-report.ts';

const query = 'SELECT id FROM public.items';
const plan = {
  'Query Text': query,
  Plan: {
    'Node Type': 'Seq Scan',
    Schema: 'public',
    'Relation Name': 'items',
    'Actual Rows': 2,
    'Shared Hit Blocks': 3,
    'Shared Read Blocks': 1,
  },
};

test('rejects an out-of-range plan owner before costing or occurrence attribution', () => {
  const capture = { statements: [query], plans: [plan], planStatements: [1] };

  expect(() => costOf(capture)).toThrow(/planStatements\[0\].*statement index/);
  expect(() => catalogStatementBound(capture)).toThrow(/planStatements\[0\].*statement index/);
  expect(() => statementAttributions(capture)).toThrow(/planStatements\[0\].*statement index/);
  expect(() => statementOccurrences(capture)).toThrow(/planStatements\[0\].*statement index/);
});

test('rejects misaligned errors and plans owned by a different known backend', () => {
  const sparseOwners: (number | undefined)[] = Array(1);
  expect(() => statementOccurrences({ statements: [query], plans: [plan], planStatements: sparseOwners })).toThrow(
    /planStatements is missing item 1/,
  );

  expect(() =>
    statementOccurrences({
      statements: [query],
      plans: [],
      statementErrors: ['42P01'],
      statementErrorMessages: [],
    }),
  ).toThrow(/statementErrorMessages has 0 items, but statements has 1/);

  expect(() =>
    costOf({
      statements: [query],
      plans: [plan],
      planStatements: [0],
      statementBackends: [101],
      planBackends: [202],
    }),
  ).toThrow(/planBackends\[0\].*conflicts with statementBackends\[0\]/);
});

test('keeps optional legacy evidence and explicitly unowned plans valid', () => {
  const legacy = { statements: [query], plans: [plan] };
  expect(costOf(legacy)).toMatchObject({ rows: 2, blocks: 4 });
  expect(statementAttributions(legacy)).toMatchObject([{ statement: query, count: 1, rows: 2, blocks: 4 }]);
  expect(statementOccurrences(legacy).statements[0]?.plans).toEqual([]);

  const unowned = { ...legacy, planStatements: [undefined] };
  expect(costOf(unowned)).toMatchObject({ rows: 2, blocks: 4 });
  expect(statementOccurrences(unowned).statements[0]?.plans).toEqual([]);
});

test('mergeGrowthCaptures pads optional evidence, rebases owners and keeps plan databases', () => {
  const kernel = {
    statements: [query],
    plans: [plan],
    planStatements: [0],
    planDatabases: ['kernel'],
    requestBytes: [11],
    responseBytes: [4],
  };
  const auth = {
    statements: ['SELECT 1'],
    plans: [
      {
        'Query Text': 'SELECT 1',
        Plan: {
          'Node Type': 'Result',
          'Actual Rows': 1,
          'Shared Hit Blocks': 2,
          'Shared Read Blocks': 0,
        },
      },
    ],
    planStatements: [0],
    planDatabases: ['auth'],
  };
  const merged = mergeGrowthCaptures([kernel, auth]);
  expect(merged.statements).toEqual([query, 'SELECT 1']);
  expect(merged.planStatements).toEqual([0, 1]);
  expect(merged.planDatabases).toEqual(['kernel', 'auth']);
  expect(merged.requestBytes).toEqual([11, 0]);
  expect(merged.responseBytes).toEqual([4, 0]);
  expect(costOf(merged)).toMatchObject({
    rows: 2,
    sharedHit: 5,
    sharedRead: 1,
    blocks: 6,
  });
});

test('rejects merged planDatabases that are not parallel to plans', () => {
  expect(() =>
    costOf({
      statements: [query],
      plans: [plan],
      planDatabases: [],
    }),
  ).toThrow(/planDatabases has 0 items, but plans has 1/);
});

const nestedPlan = { Plan: { 'Node Type': 'Result', 'Actual Rows': 7, 'Shared Hit Blocks': 11 } };
const nestedSource: Capture = {
  statements: ['SELECT 1'],
  plans: [],
  requestBytes: [900],
  responseBytes: [700],
  backgroundStatements: ['SELECT nested_work()'],
  backgroundPlans: [nestedPlan],
  backgroundPlanStatements: [0],
};

for (const [title, merged] of [
  [
    'dropped background plan and bytes',
    {
      statements: ['SELECT 1'],
      plans: [],
      requestBytes: [0],
      responseBytes: [0],
      backgroundStatements: ['SELECT nested_work()'],
    },
  ],
  ['same-count statement replacement', { ...nestedSource, statements: ['SELECT 2'] }],
  ['same-count byte replacement', { ...nestedSource, requestBytes: [1], responseBytes: [1] }],
  [
    'same-count background plan replacement',
    {
      ...nestedSource,
      backgroundPlans: [{ Plan: { 'Node Type': 'Result', 'Actual Rows': 1, 'Shared Hit Blocks': 0 } }],
    },
  ],
] satisfies ReadonlyArray<readonly [string, Capture]>) {
  test(`refuses aggregated capture ${title}`, () => {
    expect(() =>
      admitAggregatedCaptures(title, merged, [{ name: 'kernel', capture: nestedSource }], nestedSource),
    ).toThrow(/aggregateCaptures omitted native statements, plans or background work/);
  });
}
