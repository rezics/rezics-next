import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';
import { statementAttributions } from './growth-report.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('statement attribution groups literal variants while preserving quoted identifiers', () => {
  const query = (text: string, value: string, id: number, relation = 'Metric_2') =>
    String.raw`/* growth: 4 */ SELECT "${relation}"."field_8" FROM "${relation}" WHERE note = E'it\'s ${text}' AND body = $tag$${value}$tag$ AND id = ${id}`;
  const first = query('one 7', "one 11 '", 1);
  const second = query('two 23', "two 29 ' 3", 42);
  const distinct = query('three 31', "three 37 ' 5", 6, 'Metric_20');
  const plans = [
    {
      'Query Text': second,
      Plan: {
        'Node Type': 'Seq Scan',
        Schema: 'public',
        'Relation Name': 'metric_2',
        'Actual Rows': 5,
        'Shared Hit Blocks': 3,
      },
    },
    {
      'Query Text': first,
      Plan: {
        'Node Type': 'Seq Scan',
        Schema: 'public',
        'Relation Name': 'metric_2',
        'Actual Rows': 7,
        'Shared Hit Blocks': 4,
      },
    },
    {
      'Query Text': distinct,
      Plan: {
        'Node Type': 'Seq Scan',
        Schema: 'public',
        'Relation Name': 'metric_20',
        'Actual Rows': 2,
        'Shared Hit Blocks': 1,
      },
    },
  ];
  const attribution = statementAttributions({ statements: [first, second, distinct], plans });

  expect(attribution).toEqual([
    {
      statement: '/* growth: 4 */ SELECT "Metric_2"."field_8" FROM "Metric_2" WHERE note = E? AND body = ? AND id = ?',
      rows: 12,
      blocks: 7,
      count: 2,
      node: 'Seq Scan public.metric_2',
    },
    {
      statement:
        '/* growth: 4 */ SELECT "Metric_20"."field_8" FROM "Metric_20" WHERE note = E? AND body = ? AND id = ?',
      rows: 2,
      blocks: 1,
      count: 1,
      node: 'Seq Scan public.metric_20',
    },
  ]);
});

test('growth samples retain native plan documents for their exact statement occurrences', async () => {
  const report = await checkGrowth(db, {
    name: 'retained native occurrence plans',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: () =>
      withConnection(db.pool, async (client) => {
        await client.query('BEGIN');
        await client.query('SELECT 81 AS first_plan');
        await client.query('SELECT 82 AS second_plan');
        await client.query('COMMIT');
      }),
  });
  for (const sample of report.samples) {
    for (const repetition of sample.occurrenceRepetitions) {
      expect(repetition.statements.map(({ plans }) => plans)).toEqual([[], [0], [1], []]);
      expect(repetition.statements.map(({ planDocuments }) => planDocuments)).toEqual([
        [],
        [
          expect.objectContaining({
            'Query Text': 'SELECT 81 AS first_plan',
            Plan: expect.objectContaining({ 'Node Type': 'Result', Output: ['81'] }),
          }),
        ],
        [
          expect.objectContaining({
            'Query Text': 'SELECT 82 AS second_plan',
            Plan: expect.objectContaining({ 'Node Type': 'Result', Output: ['82'] }),
          }),
        ],
        [],
      ]);
    }
  }
});
