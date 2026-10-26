import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const accountId = newId(route);
const handle = 'growth_profile';
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({ pool: db.pool, routeKey: new Uint8Array(32).fill(31) });
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, handle, biography, transaction_id)
    VALUES ($1, $2, 'actor', 'active', $3, 'Profile biography', $2)`,
    [route, accountId, handle],
  );
  await db.admin.query(
    `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
    VALUES ($1, $2, $3, 'active', $3)`,
    [createHash('sha256').update(handle).digest().readUInt16BE(0), handle, accountId],
  );
});
afterAll(async () => db?.close());

test('public profile by handle stays bounded as accounts and handle claims grow', async () => {
  const report = await checkGrowth(db, {
    name: 'public profile by handle',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const count = (scale - previous) * 16;
      for (let offset = 0; offset < count; offset += 4096) {
        const ids = Array.from({ length: Math.min(4096, count - offset) }, () => newId(route));
        const handles = ids.map((id) => `grow_${id}`);
        const routes = handles.map((value) => createHash('sha256').update(value).digest().readUInt16BE(0));
        await database.admin.query(
          `INSERT INTO access.account(route, account_id, kind, state, handle, transaction_id)
          SELECT $1, id, 'actor', 'active', handle, id FROM unnest($2::uuid[], $3::text[]) AS seed(id, handle)`,
          [route, ids, handles],
        );
        await database.admin.query(
          `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
          SELECT route, handle, id, 'active', id FROM unnest($1::integer[], $2::text[], $3::uuid[]) AS seed(route, handle, id)`,
          [routes, handles, ids],
        );
      }
      await database.admin.query('VACUUM (ANALYZE) access.account');
      await database.admin.query('VACUUM (ANALYZE) access.handle_claim');
    },
    async operation() {
      const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?handle=${handle}`));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        accounts: [{ id: accountId, bio: 'Profile biography', links: [], avatar: null, subject: null }],
        next: null,
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(2);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
    expect(sample.cost.relations?.['access.handle_claim']?.rows).toBe(1);
  }
}, 60_000);
