import { expect, test } from 'bun:test';
import { catalogStatementBound, costOf } from './growth-cost.ts';
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
