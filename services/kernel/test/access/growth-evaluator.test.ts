import { afterAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';
import { newId } from '../../src/route/route.ts';

const databases: GrowthDatabase[] = [];
const rosters = new Map<ActorFixture, string[]>();
const unrelatedCounts = new Map<ActorFixture, number>();
afterAll(async () => {
  for (const db of databases) await db.close();
});

// Both axes use the same population: measured-action grants AND denials, unrelated
// accounts/resources, same-route rows, and old intervals for an exact candidate.
async function population(db: GrowthDatabase, f: ActorFixture, grants: number, memberships: number, previous: number) {
  const ids = Array.from({ length: grants - previous }, () => newId(f.resource.route));
  const nonmatches = ids.map(() => newId(f.resource.route));
  const accounts = ids.flatMap((id, index) => [id, nonmatches[index]!]);
  const roster = [...(rosters.get(f) ?? []), ...accounts];
  rosters.set(f, roster);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    SELECT $1,id,'organization','active',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, accounts, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
    SELECT $1,$2,id,'owner','subject:read','(,)',$4 FROM unnest($3::uuid[]) id`,
    [f.resource.route, f.resource.id, ids, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    SELECT $1,$2,id,'member','subject:read','resource','(,)',$4 FROM unnest($3::uuid[]) id`,
    [f.resource.route, f.resource.id, ids, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,id,id,'subject:read','(,)',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, accounts, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,$2,$3,'subject:read',tstzrange('1900-01-01'::timestamptz + n*interval '1 minute',
      '1900-01-01'::timestamptz + (n+1)*interval '1 minute','[)'),$6
    FROM generate_series($4::integer,$5::integer-1) n`,
    [f.resource.route, f.resource.id, f.staleId, previous, grants, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    SELECT $1,$2,$3,'owner','subject:read','resource',tstzrange('1900-01-01'::timestamptz + n*interval '1 minute',
      '1900-01-01'::timestamptz + (n+1)*interval '1 minute','[)'),$6
    FROM generate_series($4::integer,$5::integer-1) n`,
    [f.resource.route, f.resource.id, f.staleId, previous, grants, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
    SELECT $1,$2,id,'owner','fixture.reader','(,)',$4 FROM unnest($3::uuid[]) id`,
    [f.resource.route, f.resource.id, ids, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_id,grant_role,valid,transaction_id)
    SELECT $1,id,id,'fixture.reader','(,)',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, accounts, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
    SELECT $1,$2,$3,'owner','fixture.reader',tstzrange('1900-01-01'::timestamptz + n*interval '1 minute',
      '1900-01-01'::timestamptz + (n+1)*interval '1 minute','[)'),$6
    FROM generate_series($4::integer,$5::integer-1) n`,
    [f.resource.route, f.resource.id, f.organizationId, previous, grants, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.membership_inverse
    (route,account_id,kind,group_id,reservation_id,transaction_id)
    SELECT $1,$2,'organization',a.id,a.id,$3 FROM unnest($5::uuid[]) WITH ORDINALITY a(id,ordinal)
    ORDER BY ordinal LIMIT $4
    ON CONFLICT DO NOTHING`,
    [0x1234, f.actorId, f.transactionId, memberships - 2, roster],
  );
  await db.admin.query(
    `INSERT INTO access.organization_member
    (route,organization_id,member_account_id,role,valid,transaction_id)
    SELECT $1,i.group_id,$2,'owner','(,)',$3 FROM access.membership_inverse i
    WHERE i.route=$4 AND i.account_id=$2 AND i.group_id IN (SELECT account_id FROM access.account WHERE route=$1)
    ON CONFLICT DO NOTHING`,
    [f.resource.route, f.actorId, f.transactionId, 0x1234],
  );
  await db.admin.query(
    `INSERT INTO access.organization_member
    (route,organization_id,member_account_id,role,valid,transaction_id)
    SELECT $1,$2,$3,'owner',tstzrange('2100-01-01'::timestamptz + n*interval '1 minute',
      '2100-01-01'::timestamptz + (n+1)*interval '1 minute','[)'),$6
    FROM generate_series($4::integer,$5::integer-1) n`,
    [0x4567, f.staleId, f.actorId, previous, grants, f.transactionId],
  );
  const unrelatedCount = grants + memberships * 8;
  const noise = Array.from({ length: unrelatedCount - (unrelatedCounts.get(f) ?? 0) }, () => newId(f.resource.route));
  unrelatedCounts.set(f, unrelatedCount);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    SELECT $1,id,'actor','active',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, noise, f.transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,id,id,'subject:read','(,)',$3 FROM unnest($2::uuid[]) id`,
    [f.resource.route, noise, f.transactionId],
  );
  const admitted = await db.admin.query(
    'SELECT count(*)::integer AS count FROM access.membership_inverse WHERE route=$1 AND account_id=$2',
    [0x1234, f.actorId],
  );
  expect(admitted.rows[0].count).toBe(memberships);
  for (const table of [
    'account',
    'resource_grant',
    'resource_denial',
    'resource_role_grant',
    'membership_inverse',
    'organization_member',
  ])
    await db.admin.query(`VACUUM ANALYZE access.${table}`);
}
async function fixture() {
  const db = await openGrowthDatabase();
  databases.push(db);
  const f = await actorFixture(db.pool, db.admin);
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
    VALUES ($1,$2,$3,'owner','fixture.reader','[2020-01-01,)',$4)`,
    [f.resource.route, f.resource.id, f.organizationId, f.transactionId],
  );
  await f.deny(f.organizationId, 'member');
  await f.grant(f.staleId, 'owner');
  // Required proof outage has a real missing anchor, even with a usable direct grant.
  const missing = newId(0x789a);
  await f.admit(missing, f.principalId);
  const outage = { ...f.resource, id: newId(f.resource.route) };
  await f.grant(f.actorId, '', outage);
  await f.grant(f.principalId, '', outage);
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'owner','subject:read','resource','(,)',$4)`,
    [outage.route, outage.id, missing, f.transactionId],
  );
  const staleTarget = { ...f.resource, id: newId(f.resource.route) };
  await f.grant(f.staleId, 'owner', staleTarget);
  return { db, f, outage, staleTarget };
}
async function operation(f: ActorFixture, outage: ActorFixture['resource'], staleTarget: ActorFixture['resource']) {
  expect(await f.run()).toBe(true);
  expect(await f.run(f.delegated)).toBe(true);
  // The optional principal's required denial proof is unavailable: direct grants cannot rescue it.
  expect(await f.run(f.delegated, f.permissions(), outage)).toBe(false);
  expect(await f.run(f.actor, f.permissions(), staleTarget)).toBe(false);
  const stale = { ...f.actor, scopes: ['subject:read', 'openid', 'offline_access'] };
  expect(await f.run(stale)).toBe(true);
}

test('evaluator rows/statements are constant in G and blocks logarithmic at fixed K', async () => {
  const { db, f, outage, staleTarget } = await fixture();
  await checkGrowth(db, {
    name: 'actor evaluator G',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: (db, scale, previous) => population(db, f, scale * 256, 10, previous * 256),
    operation: () => operation(f, outage, staleTarget),
  });
}, 60000);

test('evaluator rows/statements/blocks are at most linear in admitted K through cap1000 at fixed G', async () => {
  const { db, f, outage, staleTarget } = await fixture();
  await checkGrowth(db, {
    name: 'actor evaluator K',
    scales: [10, 100, 1000],
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    grow: (db, scale, previous) => population(db, f, 4096, scale, previous ? 4096 : 0),
    operation: () => operation(f, outage, staleTarget),
  });
}, 60000);
