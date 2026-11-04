import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readAccountDiscoverySummaries, accountDiscoverySource } from '../../src/access/account-discovery-source.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { admittedAccess } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const route = 23, selected = [newId(route), newId(route), newId(route)];
const handle = `context_${selected[0]!.replaceAll('-', '')}`;
const claimRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
const access = admittedAccess({ actions: new Map() });
beforeAll(async () => { db = await openGrowthDatabase(); });
afterAll(async () => db?.close());
const read = (context = true) => readAccountDiscoverySummaries({
  pool: db.pool, routeKey: new Uint8Array(32).fill(83), access, actor: { kind: 'anonymous' }, deadline: Date.now() + 30000,
}, [...selected, selected[0]!], { context });

test('current native context keeps homonyms distinct, bounds UTF-8 before hydration and never changes indexed text', async () => {
  await db.admin.query(`INSERT INTO access.account(route,account_id,kind,state,display_name,biography,transaction_id)
    SELECT $1,id,'actor','active','Same name',CASE WHEN ordinal=1 THEN repeat('界',1000) ELSE NULL END,id
    FROM unnest($2::uuid[]) WITH ORDINALITY seed(id,ordinal)`, [route, selected]);
  await db.admin.query('UPDATE access.account SET handle=$3 WHERE route=$1 AND account_id=$2', [route, selected[0], handle]);
  await db.admin.query(`INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
    VALUES($1,$2,$3,'active',$3)`, [claimRoute, handle, selected[0]]);
  const values = await read();
  expect(values.size).toBe(3);
  const biography = values.get(selected[0]!)!.context!.biography;
  expect(biography).toEqual({ state: 'available', text: '界'.repeat(341), truncated: true });
  expect(Buffer.byteLength(JSON.stringify(values.get(selected[0]!)!.context))).toBeLessThanOrEqual(8192);
  expect(values.get(selected[1]!)!.context).toEqual({ biography: { state: 'withheld' }, followTarget: { state: 'unavailable' } });
  expect((await read(false)).get(selected[0]!)!.context).toBeUndefined();
  expect((await accountDiscoverySource(db.pool).read(partitionOf(route), selected)).accounts[0]).not.toHaveProperty('biography');
  await db.admin.query('UPDATE access.account SET biography=NULL WHERE route=$1 AND account_id=$2', [route, selected[0]]);
  expect((await read()).get(selected[0]!)!.context!.biography).toEqual({ state: 'absent' });
  await db.admin.query("UPDATE access.handle_claim SET state='reserved' WHERE route=$1 AND normalized_handle=$2", [claimRoute, handle]);
  expect((await read()).get(selected[0]!)).toMatchObject({ handle: null, context: { biography: { state: 'withheld' } } });
  await db.admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [route, selected[0]]);
  expect((await read()).get(selected[0]!)).toBeNull();
  await db.admin.query("UPDATE access.account SET authn_fenced=false, biography=repeat('界',1000) WHERE route=$1 AND account_id=$2", [route, selected[0]]);
  await db.admin.query("UPDATE access.handle_claim SET state='active' WHERE route=$1 AND normalized_handle=$2", [claimRoute, handle]);
});

test('fixed Account page and byte bounds remain constant as unrelated native populations grow', async () => {
  const report = await checkGrowth(db, {
    name: 'Selected Account public context', scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: scale - previous }, () => newId(route));
      await database.admin.query(`INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id)
        SELECT $1,id,'actor','active','Unrelated population',id FROM unnest($2::uuid[]) seed(id)`, [route, ids]);
    },
    async operation() {
      const result = await read();
      expect(result.size).toBe(3);
      expect(Buffer.byteLength(JSON.stringify([...result.values()]))).toBeLessThanOrEqual(3 * 8192);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
}, 120000);
