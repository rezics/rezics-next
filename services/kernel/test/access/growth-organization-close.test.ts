import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createOrganizationCloseRunner } from '../../src/access/organization-close-work.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => {
  await db?.close();
});
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const key = () => Bun.randomUUIDv7();
const organizationRoute = 0x2771,
  memberRoute = 0x2781;
async function seedFixedIndexes() {
  const ids = Array.from({ length: 4096 }, () => newId(organizationRoute));
  await db.admin.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) SELECT $1,id,id,'account:manage','(,)',id FROM unnest($2::uuid[]) id",
    [organizationRoute, ids],
  );
  await db.admin.query(
    "INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response) SELECT $1,'account',id,'access.fixture',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($2::uuid[]) id",
    [organizationRoute >>> 4, ids],
  );
  await db.admin.query(
    'INSERT INTO access.organization_close(route,organization_id,receipt_id,handle_key,complete) SELECT $1,id,id,id::text,true FROM unnest($2::uuid[]) id',
    [organizationRoute, ids],
  );
}
async function seedOrganization(count: number, history = false) {
  const owner = newId(memberRoute),
    org = newId(organizationRoute);
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
    [memberRoute, owner],
  );
  const internal = createLifecycleInternals({
    pool: db.admin,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const held = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: org,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId: org,
    ownerAccountId: owner,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  const members = Array.from({ length: count }, () => newId(memberRoute));
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id",
    [memberRoute, members],
  );
  await db.admin.query(
    "INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id) SELECT $1,$2,id,'member',CASE WHEN $4 THEN '[2001-01-01,)'::tstzrange ELSE '(,)'::tstzrange END,id FROM unnest($3::uuid[]) id",
    [organizationRoute, org, members, history],
  );
  if (history)
    await db.admin.query(
      "INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id) SELECT $1,$2,id,'member','[2000-01-01,2001-01-01)',id FROM unnest($3::uuid[]) id",
      [organizationRoute, org, members],
    );
  await db.admin.query(
    'INSERT INTO access.lifecycle_membership_slot(route,organization_id,member_account_id,reservation_id,transaction_id) SELECT $1,$2,id,id,id FROM unnest($3::uuid[]) id',
    [organizationRoute, org, members],
  );
  await db.admin.query(
    "INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id) SELECT $1,id,'organization',$2,id,id FROM unnest($3::uuid[]) id",
    [memberRoute, org, members],
  );
  await db.admin.query(
    "INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id) SELECT $1,id,id,$2,'membership',id FROM unnest($3::uuid[]) id",
    [memberRoute, org, members],
  );
  return { owner, org };
}
async function context(owner: string, pool = db.pool) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30000 },
    { accountId: owner, clientId: 'close-growth', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  return { actor, deadline: Date.now() + 30000 };
}

test('close has constant rows and statements as target and unrelated memberships grow', async () => {
  let targets: { owner: string; org: string }[] = [];
  const commands = createLifecycleCommands({ pool: db.pool, access });
  const report = await checkGrowth(db, {
    name: 'close organization',
    scales: [256, 1024, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      if (previous === 0) await seedFixedIndexes();
      targets = [await seedOrganization(scale), await seedOrganization(scale)];
      await seedOrganization(scale); // Other organization members share the same indexes.
    },
    async operation() {
      const target = targets.shift()!;
      await commands.tombstone(await context(target.owner), { accountId: target.org, key: key() });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
}, 120000);

test('one deep cleanup page stays bounded as current, history and unrelated memberships grow', async () => {
  let targets: { owner: string; org: string; sequence: number; pages: number }[] = [];
  const setup = createLifecycleCommands({ pool: db.admin, access });
  const runner = createOrganizationCloseRunner({ pool: db.pool });
  const preparation = createOrganizationCloseRunner({ pool: db.admin });
  async function earlierPages() {
    const target = targets[0]!;
    while (target.sequence < target.pages) {
      const result = await preparation.step(target.org, target.sequence);
      expect(result.count).toBe(100);
      target.sequence++;
    }
  }
  async function operation() {
    const { org, sequence } = targets.shift()!;
    expect(await runner.step(org, sequence)).toEqual({ count: 100, next: sequence + 1 });
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int n FROM access.organization_member WHERE route=$1 AND organization_id=$2',
          [routeOf(org), org],
        )
      ).rows[0].n,
    ).toBeGreaterThan(100);
  }
  const report = await checkGrowth(db, {
    name: 'organization cleanup step',
    scales: [256, 1024, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      if (previous === 0) await seedFixedIndexes();
      targets = await Promise.all(
        [0, 1].map(async () => ({
          ...(await seedOrganization(scale, true)),
          sequence: 0,
          pages: Math.floor((scale * 2 - 200) / 100),
        })),
      );
      await seedOrganization(scale, true);
      for (const target of targets)
        await setup.tombstone(await context(target.owner, db.admin), { accountId: target.org, key: key() });
    },
    // Preparation runs after VACUUM so the measured seek must skip dead entries
    // from all preceding pages, which grow with the organization's history.
    prepare: earlierPages,
    async warmup() {
      await earlierPages();
      await operation();
    },
    operation,
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
}, 240000);
