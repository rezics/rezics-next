import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const routeKey = new Uint8Array(32).fill(19);
const requestedIds = Array.from({ length: 100 }, () => newId(route));
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({ pool: db.pool, routeKey });
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, transaction_id)
     SELECT $1, account_id, 'actor', 'requested_' || ordinal, 'Requested ' || ordinal, 'active', account_id
     FROM unnest($2::uuid[]) WITH ORDINALITY AS requested(account_id, ordinal)`,
    [route, requestedIds],
  );
});

afterAll(async () => db?.close());

test('a fixed 100-account public identity batch stays bounded as unrelated accounts grow', async () => {
  const path = `/v1/accounts?ids=${requestedIds.join(',')}`;
  const report = await checkGrowth(db, {
    name: 'public identity read',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    rule: 'series',
    // One measured batch × one account_pkey probe for each of the 100 requested identities.
    indexProbes: 100,
    repetitions: 1,
    async grow(database, scale, previous) {
      const count = (scale - previous) * 2000;
      for (let offset = 0; offset < count; offset += 5000) {
        const ids = Array.from({ length: Math.min(5000, count - offset) }, () => newId(route));
        await database.admin.query(
          `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
           SELECT $1, account_id, 'actor', 'active', account_id FROM unnest($2::uuid[]) AS requested(account_id)`,
          [route, ids],
        );
      }
      await database.admin.query('VACUUM (ANALYZE) access.account');
    },
    async operation() {
      const response = await kernel.handle(new Request(`https://kernel.test${path}`));
      const body = (await response.json()) as { accounts: { id: string }[] };
      if (response.status === 503) throw new Error(JSON.stringify(body));
      expect(response.status).toBe(200);
      expect(body.accounts.map(({ id }) => id)).toEqual(requestedIds);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(1);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(100);
  }
}, 60_000);
