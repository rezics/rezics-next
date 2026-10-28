import { afterAll, expect, test } from 'bun:test';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { prepareReadDecisions } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import type { ReadDecisions } from '../../src/request/access.ts';

const databases: GrowthDatabase[] = [];
afterAll(async () => {
  for (const db of databases) await db.close();
});
const action = 'subject:read';
async function fixture() {
  const db = await openGrowthDatabase();
  databases.push(db);
  const f = await actorFixture(db.pool, db.admin);
  const account = await readAccount(db.admin, routeOf(f.actorId)!, f.actorId);
  const access = f.permissions({ accountEvidence: () => account });
  return { db, f, access };
}
// Stored ACL size, unrelated organization count and exact-key historical intervals
// grow together. The admitted inverse remains fixed for the history axis.
async function grow(db: GrowthDatabase, f: ActorFixture, scale: number, previous: number) {
  if (!previous)
    await db.admin.query(
      `UPDATE access.resource_grant SET valid='[2020-01-01,)'::tstzrange
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4`,
      [f.resource.route, f.resource.id, f.actorId, action],
    );
  const ids = Array.from({ length: (scale - previous) * 32 }, () => newId(f.resource.route));
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    SELECT $1,id,'organization','active',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, ids, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
    SELECT $1,$2,id,'owner',$3,'(,)',$4 FROM unnest($5::uuid[]) id`,
    [f.resource.route, f.resource.id, action, f.transactionId, ids],
  );
  for (const table of ['resource_grant', 'resource_role_grant', 'resource_denial']) {
    const extra =
      table === 'resource_denial' ? 'action,reason' : table === 'resource_role_grant' ? 'grant_role' : 'action';
    const values =
      table === 'resource_denial'
        ? "'subject:read','resource'"
        : table === 'resource_role_grant'
          ? "'fixture.reader'"
          : "'subject:read'";
    await db.admin.query(
      `INSERT INTO access.${table}
      (route,resource_id,subject_id,subject_role,${extra},valid,transaction_id)
      SELECT $1,$2,$3,'',${values},tstzrange('1900-01-01'::timestamptz+n*interval '1 minute',
        '1900-01-01'::timestamptz+(n+1)*interval '1 minute','[)'),$4
      FROM generate_series($5::integer,$6::integer-1) n`,
      [f.resource.route, f.resource.id, f.actorId, f.transactionId, previous * 32, scale * 32],
    );
  }
  await db.admin.query(
    `INSERT INTO access.organization_member
    (route,organization_id,member_account_id,role,valid,transaction_id)
    SELECT $1,$2,$3,'owner',tstzrange('1900-01-01'::timestamptz+n*interval '1 minute',
      '1900-01-01'::timestamptz+(n+1)*interval '1 minute','[)'),$4
    FROM generate_series($5::integer,$6::integer-1) n`,
    [routeOf(f.staleId), f.staleId, f.actorId, f.transactionId, previous * 32, scale * 32],
  );
}

test('prepare stays at E=3 with constant rows and logarithmic blocks as grants, unrelated groups and history grow', async () => {
  const { db, f, access } = await fixture();
  const report = await checkGrowth(db, {
    name: 'read decisions preparation history',
    scales: [1, 8, 64],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    grow: (db, scale, previous) => grow(db, f, scale, previous),
    async operation() {
      const handle = await prepareReadDecisions(access, {
        actor: f.actor,
        actions: new Set([action, 'subject:update']),
        context: { pool: db.pool, deadline: Date.now() + 5000 },
      });
      expect(Object.keys(handle)).toEqual(['decide']);
    },
  });
  for (const sample of report.samples) expect(sample.cost.statements).toBe(3);
}, 120000);

test('all admitted organization pairs use one anchor statement as J grows at three scales', async () => {
  const { db, f, access } = await fixture();
  const report = await checkGrowth(db, {
    name: 'read decisions admitted organization pairs',
    scales: [1, 8, 64],
    bounds: { statements: 'constant', rows: 'linear', blocks: 'linear' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: scale - previous }, () => newId(0x7890));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'organization','active',$3 FROM unnest($2::uuid[]) id`,
        [0x7890, ids, f.transactionId],
      );
      await database.admin.query(
        `INSERT INTO access.membership_inverse
        (route,account_id,kind,group_id,reservation_id,transaction_id)
        SELECT $1,$2,'organization',id,id,$3 FROM unnest($4::uuid[]) id`,
        [routeOf(f.actorId), f.actorId, f.transactionId, ids],
      );
      await database.admin.query(
        `INSERT INTO access.organization_member
        (route,organization_id,member_account_id,role,valid,transaction_id)
        SELECT $1,id,$2,'owner','(,)',$3 FROM unnest($4::uuid[]) id`,
        [0x7890, f.actorId, f.transactionId, ids],
      );
    },
    async operation() {
      await prepareReadDecisions(access, {
        actor: f.actor,
        actions: new Set([action]),
        context: { pool: db.pool, deadline: Date.now() + 5000 },
      });
    },
  });
  for (const sample of report.samples) expect(sample.cost.statements).toBe(3);
}, 120000);

for (const count of [1, 100, 200])
  for (const partitions of ['one', 'many']) {
    test(`decide ${count} ids over ${partitions} partitions uses one statement as grants, groups and history grow`, async () => {
      const { db, f, access } = await fixture();
      let ids: string[] = [];
      const report = await checkGrowth(db, {
        name: `read decisions ${count} ids ${partitions} partitions`,
        scales: [1, 8, 64],
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        async grow(database, scale, previous) {
          if (!previous) {
            ids = [
              f.resource.id,
              ...Array.from({ length: count - 1 }, (_, index) =>
                newId(partitions === 'one' ? f.resource.route : 0x7000 + index * 16),
              ),
            ];
            await database.admin.query(
              `INSERT INTO access.resource_grant
            (route,resource_id,subject_id,action,valid,transaction_id)
            SELECT route,id,$3,$4,'(,)',$5 FROM unnest($1::integer[],$2::uuid[]) targets(route,id)`,
              [ids.slice(1).map(routeOf), ids.slice(1), f.actorId, action, f.transactionId],
            );
          }
          await grow(database, f, scale, previous);
        },
        async operation() {
          // The same production prepare path uses an uninstrumented connection;
          // capture contains only the caller's snapshot and its sole formula.
          const handle: ReadDecisions = await prepareReadDecisions(access, {
            actor: f.actor,
            actions: new Set([action]),
            context: { pool: db.admin, deadline: Date.now() + 5000 },
          });
          const client = await db.pool.connect();
          try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const decisions = await handle.decide(client, { action, resourceType: 'subject', ids });
            expect(Object.keys(decisions)).toHaveLength(count);
            for (const id of ids) expect(decisions[id]).toEqual({ allowed: true, explicit: true });
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      });
      for (const sample of report.samples) expect(sample.cost.statements).toBe(1);
    }, 180000);
  }
