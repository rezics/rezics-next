import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createRatingCounter } from '../../src/access/rating-counter.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const operator = newId(route);
const subject = newId(route);
const ratingCounter = createRatingCounter({ secret: randomBytes(32) });
const at = '2026-10-26T00:00:00.000Z';
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());

test('counting keys stay constant as accounts and operated accounts grow', async () => {
  let expected: string;
  const report = await checkGrowth(db, {
    name: 'rating counter point read',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
           VALUES ($1,$2,'actor','active',NULL,$2), ($1,$3,'actor','active',$2,$3)`,
          [route, operator, subject],
        );
        expected = await ratingCounter(database.admin, operator, at);
      }
      const ids = Array.from({ length: (scale - previous) * 2 }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
         SELECT $1,id,'actor','active',CASE WHEN ordinal % 2 = 0 THEN $3::uuid ELSE NULL END,id
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ids(id,ordinal)`,
        [route, ids, operator],
      );
    },
    async operation() {
      expect(await ratingCounter(db.pool, subject, at)).toBe(expected);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
}, 60000);
