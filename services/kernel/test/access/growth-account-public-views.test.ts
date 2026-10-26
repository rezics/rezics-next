import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readPublicViews } from '../../src/access/index.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routes = [0x4510, 0x4520, 0x4530, 0x4540];
// Each partition includes multiple routes, so grouping by route would violate the statement bound.
const targetRoutes = routes.flatMap((route) => Array.from({ length: 5 }, (_, i) => route + i));
const ids = targetRoutes.map(newId);
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(() => db?.close());

test('public view flags for 20 accounts across 4 partitions stay bounded as accounts grow', async () => {
  const report = await checkGrowth(db, {
    name: 'public view flags across partitions',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0)
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT route,id,'actor','active',id FROM unnest($1::integer[],$2::uuid[]) seed(route,id)`,
          [targetRoutes, ids],
        );
      for (const route of routes) {
        const count = (scale - previous) * 16;
        for (let offset = 0; offset < count; offset += 4096) {
          const growing = Array.from({ length: Math.min(4096, count - offset) }, () => newId(route));
          await database.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
            SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) seed(id)`,
            [route, growing],
          );
        }
      }
    },
    async operation() {
      const result = await readPublicViews(db.pool, ids);
      expect(result.size).toBe(20);
      for (const id of ids) expect(result.get(id)).toEqual({ posts: true, reviews: true, collections: true });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(4);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(20);
  }
}, 60_000);
