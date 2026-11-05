import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readAgentPages } from '../../src/access/account-data.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const target = newId(0);
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());

async function grow(database: GrowthDatabase, scale: number, previous: number) {
  if (previous === 0) {
    await database.admin.query('TRUNCATE access.account CASCADE');
    await database.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id)
      VALUES (0,$1,'actor','active','growth_target',$1)`,
      [target],
    );
  }
  const ids = Array.from({ length: (scale - previous) * 4 }, () => newId(23));
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,handle,transaction_id)
    SELECT 23,id,'actor',CASE ord % 4 WHEN 1 THEN 'pending' WHEN 2 THEN 'deleted' ELSE 'active' END,
      ord % 4 = 3, 'growth_' || replace(id::text,'-',''), id
    FROM unnest($1::uuid[]) WITH ORDINALITY seed(id,ord)`,
    [ids],
  );
}

test('agent pages stay bounded as listed and unlisted accounts grow', async () => {
  const report = await checkGrowth(db, {
    name: 'agent pages stay bounded as listed and unlisted accounts grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    grow,
    async operation() {
      const first = await readAgentPages(db.pool, tokens, { limit: 3 });
      expect(first.agentPages).toHaveLength(3);
      expect(first.next).not.toBeNull();
      const next = await readAgentPages(db.pool, tokens, { limit: 3, cursor: first.next! });
      expect(next.agentPages).toHaveLength(3);
      expect(next.agentPages[0]!.handle).not.toBe(first.agentPages[0]!.handle);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(2);
    expect(cost.relations?.['access.account']?.rows).toBeLessThanOrEqual(8);
  }
}, 60_000);

test('public change time stays bounded as accounts grow', async () => {
  const report = await checkGrowth(db, {
    name: 'public change time stays bounded as accounts grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    grow,
    async operation(_database, _scale, repetition) {
      const result = await db.pool.query(
        `UPDATE access.account SET display_name=$2
        WHERE route=0 AND account_id=$1 RETURNING public_changed_at > created_at AS changed`,
        [target, `Name ${repetition}`],
      );
      expect(result.rows).toEqual([{ changed: true }]);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) expect(cost.statements).toBe(1);
}, 60_000);
