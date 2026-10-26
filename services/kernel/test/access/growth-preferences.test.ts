import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readAccountPreferences } from '../../src/access/preferences.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const accountId = newId(route);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());

test('preferences read stays constant as accounts with stored preferences grow', async () => {
  const report = await checkGrowth(db, {
    name: 'account preferences read',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
           VALUES ($1,$2,'actor','active',$2)`,
          [route, accountId],
        );
        await database.admin.query(
          `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,version)
           VALUES ($1,$2,1,'show',1)`,
          [route, accountId],
        );
      }
      // Keep the smallest sample beyond the planner's tiny-table scan threshold.
      const ids = Array.from({ length: (scale - previous) * 16 }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,version)
        SELECT $1,id,2,'blur',1 FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
    },
    async operation() {
      expect(await readAccountPreferences(db.pool, accountId)).toEqual({
        spoilerLevel: 1,
        suitability: 'show',
        version: 1,
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
}, 60000);
