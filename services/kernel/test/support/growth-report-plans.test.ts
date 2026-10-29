import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
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
