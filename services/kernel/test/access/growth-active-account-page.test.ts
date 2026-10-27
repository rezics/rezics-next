import { afterAll, beforeAll, expect, test } from 'bun:test';
import { pageActiveAccounts } from '../../src/access/active-account-page.ts';
import backfillPage from '../../src/access/account-agent-active-page.sql';
import { withConnection } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 23;
const afterAccountId = '00000000-0000-8000-8000-001700000001';
const targets = Array.from({ length: 6 }, (_, i) => ({
  route,
  accountId: `ffffffff-0000-8000-8000-0017${(i + 1).toString(16).padStart(8, '0')}`,
}));
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(() => db?.close());

async function grow(database: GrowthDatabase, scale: number, previous: number) {
  if (previous === 0) {
    await database.admin.query('TRUNCATE access.account CASCADE');
    await database.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id)
       SELECT $1,id,'actor','active','Active without a handle',id FROM unnest($2::uuid[]) seed(id)`,
      [route, [afterAccountId, ...targets.map(({ accountId }) => accountId)]],
    );
  }
  // All inactive rows lie between the cursor and the requested active rows in the primary key.
  const ids = Array.from({ length: (scale - previous) * 4 }, () => newId(route));
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,handle,transaction_id)
     SELECT $1,id,'actor',CASE ord % 4 WHEN 0 THEN 'active' WHEN 1 THEN 'pending'
       WHEN 2 THEN 'deleted' ELSE 'suspended' END,ord % 4 = 0,
       'inactive_' || replace(id::text,'-',''),id
     FROM unnest($2::uuid[]) WITH ORDINALITY seed(id,ord)`,
    [route, ids],
  );
}

test('active account page reads stay bounded as inactive accounts grow', async () => {
  const report = await checkGrowth(db, {
    name: 'active account page reads stay bounded as inactive accounts grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow,
    async operation(database) {
      expect(
        await withConnection(database.pool, (client) =>
          pageActiveAccounts(client, { afterRoute: route, afterAccountId, limit: 3 }),
        ),
      ).toEqual(targets.slice(0, 3));
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(1);
    expect(cost.relations?.['access.account']?.rows).toBe(3);
    expect(cost.relations?.['access.account']?.sequentialScans).toBe(0);
  }
  const { capture: raw } = await capture(db, () =>
    withConnection(db.pool, (client) => pageActiveAccounts(client, { afterRoute: route, afterAccountId, limit: 3 })),
  );
  expect(JSON.stringify(raw.plans)).toContain('"Index Name":"account_active_pages"');
}, 60_000);

test('the account agent backfill page uses the same index', async () => {
  const report = await checkGrowth(db, {
    name: 'account agent backfill page reads stay bounded as inactive accounts grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow,
    async operation(database) {
      const page = await withConnection(database.pool, (client) =>
        backfillPage.run(client, { after_route: route, after_account_id: afterAccountId, page_size: 3 }),
      );
      expect(page.map(({ route, accountId }) => ({ route, accountId }))).toEqual(targets.slice(0, 3));
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(1);
    expect(cost.relations?.['access.account']?.rows).toBe(3);
    expect(cost.relations?.['access.account']?.sequentialScans).toBe(0);
  }
  const { capture: raw } = await capture(db, () =>
    withConnection(db.pool, (client) =>
      backfillPage.run(client, { after_route: route, after_account_id: afterAccountId, page_size: 3 }),
    ),
  );
  expect(JSON.stringify(raw.plans)).toContain('"Index Name":"account_active_pages"');
}, 60_000);
