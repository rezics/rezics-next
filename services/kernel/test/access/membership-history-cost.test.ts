import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import type { Access } from '../../src/request/access.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  assertGrowth,
  capture,
  checkGrowth,
  costOf,
  medianCost,
  openGrowthDatabase,
  type Cost,
  type GrowthDatabase,
} from '../support/growth.ts';
import { nodes, type Plan } from './owner-cost-fixture.ts';
import membershipChange from '../../src/access/lifecycle-membership.sql';
import memberInsert from '../../src/access/lifecycle-member-insert.sql';

let db: GrowthDatabase;
let commands: ReturnType<typeof createLifecycleCommands>;
let access: Access;
let internal: ReturnType<typeof createLifecycleInternals>;
const route = 0x7430;
const organizationId = newId(route);
const otherOrganization = newId(route);
const elsewhere = newId(route + 1);
const owner = newId(0x1234);
const member = newId(0x1234);
const at = new Date().toISOString();
const past = new Date(Date.parse(at) - 86_400_000).toISOString();
const future = new Date(Date.parse(at) + 86_400_000).toISOString();
const later = new Date(Date.parse(at) + 172_800_000).toISOString();
const key = () => Bun.randomUUIDv7();
let clockReads = 0;
const clock = () => {
  clockReads++;
  return new Date(at);
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  commands = createLifecycleCommands({ pool: db.pool, access, clock });
  internal = createLifecycleInternals({
    pool: db.pool,
    clock,
    routeKey: new Uint8Array(32).fill(71),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  for (const [id, kind] of [
    [organizationId, 'organization'],
    [owner, 'actor'],
    [member, 'actor'],
  ] as const) {
    await db.admin.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,$3,'active',$2)`,
      [routeOf(id), id, kind],
    );
  }
  await db.admin.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'organization:membership','(,)',$3)`,
    [route, organizationId, owner],
  );
  await db.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES ($1,$2,'organization',$3,$4,$4)`,
    [routeOf(owner), owner, organizationId, owner],
  );
});
afterAll(async () => {
  if (db) await db.close();
});

async function context() {
  return {
    actor: await authenticateAccount(
      access,
      { pool: db.pool, deadline: Date.now() + 10_000 },
      {
        accountId: owner,
        clientId: 'membership-cost',
        requestedBy: null,
        authnEpoch: 1,
        scopes: [...LIFECYCLE_ACTIONS.keys()],
      },
    ),
    account: await readAccount(db.admin, routeOf(owner)!, owner),
    deadline: Date.now() + 5000,
  };
}
async function reserve(memberAccountId = member) {
  return (
    await internal.reserveCoordination({
      accountId: memberAccountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    })
  ).value;
}
async function change(
  reservationId: string,
  role: 'owner' | 'member' | null,
  memberAccountId = member,
  commandKey = key(),
) {
  return commands.setMembership(await context(), {
    organizationId,
    memberAccountId,
    reservationId,
    role,
    key: commandKey,
  });
}
async function insert(id: string, role: string, lower: string | null, upper: string | null) {
  await db.admin.query(
    `INSERT INTO access.organization_member (route,organization_id,member_account_id,role,valid,transaction_id)
     VALUES ($1,$2,$3,$4,tstzrange($5,$6,'[)'),$3)`,
    [route, organizationId, id, role, lower, upper],
  );
}
async function seed(scale: number, lower: string | null = past, scheduled = true) {
  await db.admin.query('TRUNCATE access.organization_member');
  await insert(owner, 'owner', null, null);
  await insert(member, 'member', lower, scheduled ? future : null);
  if (scheduled) await insert(member, 'owner', future, later);
  await db.admin.query(
    `INSERT INTO access.organization_member (route,organization_id,member_account_id,role,valid,transaction_id)
     SELECT anchor.route,anchor.org,
       CASE WHEN category=0 AND $7::boolean THEN $4::uuid ELSE md5(category::text || ':' || i::text)::uuid END,
       CASE WHEN category=0 THEN 'owner' ELSE 'member' END,
       CASE WHEN category=0 THEN tstzrange('2000-01-01'::timestamptz + i * interval '1 hour',
                                          '2000-01-01'::timestamptz + i * interval '1 hour' + interval '30 minutes','[)')
            ELSE '(,)'::tstzrange END,$2
     FROM generate_series(1,$3::integer) i
     CROSS JOIN (VALUES (0,$1::integer,$2::uuid),(1,$1,$2),(2,$1,$5::uuid),
                        (3,$1::integer+1,$6::uuid)) anchor(category,route,org)`,
    [route, organizationId, scale, member, otherOrganization, elsewhere, lower !== null],
  );
  await db.admin.query('VACUUM (ANALYZE) access.organization_member');
}
async function history(until = past) {
  return (
    await db.admin.query(
      `SELECT role,valid::text,transaction_id::text FROM access.organization_member
     WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND upper(valid) <= $4::timestamptz
     ORDER BY valid`,
      [route, organizationId, member, until],
    )
  ).rows;
}
async function roles(instant: string) {
  return (
    await db.admin.query(
      `SELECT role FROM access.organization_member
     WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND valid @> $4::timestamptz`,
      [route, organizationId, member, instant],
    )
  ).rows.map((row) => row.role);
}
async function snapshot() {
  return (
    await db.admin.query(
      `SELECT role,valid::text,transaction_id::text FROM access.organization_member
     WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 ORDER BY valid`,
      [route, organizationId, member],
    )
  ).rows;
}

test('replacement preserves expired history and closes current authority at the single command time', async () => {
  await seed(32);
  const old = await history();
  const hold = await reserve();
  const reads = clockReads;
  const result = await change(hold.reservationId, 'owner');
  expect(clockReads - reads).toBe(1);
  expect(await history()).toEqual(old);
  expect(await roles(past)).toEqual(['member']);
  expect(await roles(new Date(Date.parse(at) - 1).toISOString())).toEqual(['member']);
  expect(await roles(at)).toEqual(['owner']);
  expect(await roles(later)).toEqual(['owner']);
  expect(
    (
      await db.admin.query(
        `SELECT lower(valid) = $4::timestamptz AS starts, upper_inf(valid) AS ongoing
     FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3
       AND transaction_id=$5 AND role='owner'`,
        [route, organizationId, member, at, result.transactionId],
      )
    ).rows,
  ).toEqual([{ starts: true, ongoing: true }]);
});

test('exact lower boundary and unbounded lower history never create an empty interval', async () => {
  for (const lower of [at, null]) {
    for (const role of ['owner', null] as const) {
      await seed(32, lower);
      const old = await history();
      const hold = await reserve();
      await change(hold.reservationId, role);
      expect(await history()).toEqual(old);
      expect(await roles(at)).toEqual(role === null ? [] : ['owner']);
      expect(await roles(past)).toEqual(lower === null ? ['member'] : []);
      expect(await roles(later)).toEqual(role === null ? [] : ['owner']);
    }
  }
});

test('completed authority ending at T stays unchanged when only scheduled authority remains', async () => {
  for (const role of ['owner', null] as const) {
    await seed(32);
    await db.admin.query(
      `UPDATE access.organization_member SET valid=tstzrange($4,$5,'[)')
       WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND valid @> $4::timestamptz`,
      [route, organizationId, member, past, at],
    );
    const old = await history(at);
    const hold = await reserve();
    await change(hold.reservationId, role);
    expect(await history(at)).toEqual(old);
    expect(await roles(past)).toEqual(['member']);
    for (const instant of [at, future, later]) expect(await roles(instant)).toEqual(role === null ? [] : ['owner']);
  }
});

test('leave closes current and scheduled authority before exact inverse release and terminal replay', async () => {
  await seed(32);
  const old = await history();
  const hold = await reserve();
  const release = { organizationId, memberAccountId: member, reservationId: hold.reservationId, key: key() };
  await change(hold.reservationId, 'member');
  await expect(internal.releaseMembershipCoordination(release)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await seed(32);
  const commandKey = key();
  const removed = await change(hold.reservationId, null, member, commandKey);
  expect(await history()).toEqual(old);
  expect(await roles(past)).toEqual(['member']);
  for (const instant of [at, future, later]) expect(await roles(instant)).toEqual([]);
  await expect(change(hold.reservationId, 'owner')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await internal.releaseMembershipCoordination(release);
  const replay = await change(hold.reservationId, null, member, commandKey);
  expect(replay.replayed).toBe(true);
  expect(replay.transactionId).toBe(removed.transactionId);
  expect(
    (
      await db.admin.query(
        `SELECT reservation_id FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3`,
        [routeOf(member), member, hold.reservationId],
      )
    ).rows,
  ).toEqual([]);
  for (const instant of [at, future, later]) expect(await roles(instant)).toEqual([]);
});

test('receipt failure rolls back history, terminal slot and effects; last owner remains protected', async () => {
  await seed(32);
  const hold = await reserve();
  const before = await snapshot();
  const counts = async () =>
    (
      await db.admin.query(
        `SELECT (SELECT count(*) FROM core.receipt) AS receipts, (SELECT count(*) FROM core.outbox) AS events`,
      )
    ).rows;
  const effects = await counts();
  await db.admin.query(`CREATE FUNCTION public.reject_membership_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.command_kind='access.membership-changed' THEN RAISE EXCEPTION 'membership receipt failure';
    END IF; RETURN NEW; END $$`);
  await db.admin.query(`CREATE TRIGGER reject_membership_receipt BEFORE INSERT ON core.receipt
    FOR EACH ROW EXECUTE FUNCTION public.reject_membership_receipt()`);
  try {
    await expect(change(hold.reservationId, null)).rejects.toThrow('membership receipt failure');
  } finally {
    await db.admin.query('DROP TRIGGER reject_membership_receipt ON core.receipt');
    await db.admin.query('DROP FUNCTION public.reject_membership_receipt()');
  }
  expect(await snapshot()).toEqual(before);
  expect(await counts()).toEqual(effects);
  expect(
    (
      await db.admin.query(
        `SELECT terminal FROM access.lifecycle_membership_slot
     WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4`,
        [route, organizationId, member, hold.reservationId],
      )
    ).rows,
  ).toEqual([]);
  await expect(
    internal.releaseMembershipCoordination({
      organizationId,
      memberAccountId: member,
      reservationId: hold.reservationId,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const ownerHold = await reserve(owner);
  for (const role of ['member', null] as const)
    await expect(change(ownerHold.reservationId, role, owner)).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await snapshot()).toEqual(before);
});

const growthCases = [false, true].flatMap((scheduled) =>
  (['owner', null] as const).map((role) => ({ scheduled, role })),
);

for (const { scheduled, role } of growthCases) {
  test(`scales 256 1024 4096 keep actual membership mutation rows fixed as expired history and background grow (${scheduled ? 'scheduled' : 'ongoing'} member, ${role ?? 'removal'})`, async () => {
    // Native commands admit one ongoing interval. Scheduled replacement measures
    // fixed k=2 as well: arbitrary future scheduling needs a bounded admission or
    // separately anchored workflow before it can promise fixed command work.
    const bounds = { rows: 'constant', statements: 'constant', blocks: 'logarithmic' } as const;
    // Reservation and fixture reads use the plain pool, so a capture holds only the command.
    const reserver = createLifecycleInternals({
      pool: db.admin,
      clock,
      routeKey: new Uint8Array(32).fill(71),
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });
    const started = new Date();
    // Every run starts from the same receipts, coordination state and the member's current and scheduled intervals;
    // only membership history and background membership populations grow with the scale.
    async function exercise() {
      await db.admin.query('TRUNCATE access.lifecycle_coordination, access.lifecycle_membership_slot');
      await db.admin.query('DELETE FROM core.receipt WHERE created_at >= $1', [started]);
      await db.admin.query(
        `DELETE FROM access.organization_member
         WHERE route=$1 AND organization_id=$2 AND member_account_id=$3
           AND (upper_inf(valid) OR upper(valid) > $4::timestamptz)`,
        [route, organizationId, member, past],
      );
      await insert(member, 'member', past, scheduled ? future : null);
      if (scheduled) await insert(member, 'owner', future, later);
      const old = await history();
      const hold = (
        await reserver.reserveCoordination({
          accountId: member,
          relatedAccountId: organizationId,
          purpose: 'membership',
          key: key(),
        })
      ).value;
      const ctx = await context();
      await commands.setMembership(ctx, {
        organizationId,
        memberAccountId: member,
        reservationId: hold.reservationId,
        role,
        key: key(),
      });
      expect(await history()).toEqual(old);
    }
    function mutationCostOf(captured: { plans: readonly unknown[] }): Cost {
      const plans = captured.plans as { 'Query Text': string; Plan: Plan }[];
      expect(
        plans.filter((p) => p['Query Text'] === membershipChange.sql || p['Query Text'] === memberInsert.sql),
      ).toHaveLength(role === null ? 1 : 2);
      const mutationPlans = plans.filter(
        (p) =>
          p['Query Text'] === membershipChange.sql ||
          p['Query Text'] === memberInsert.sql ||
          p['Query Text'].startsWith('SELECT m.valid') ||
          p['Query Text'].includes('CURRENT OF overlapping'),
      );
      const scans = mutationPlans
        .flatMap((p) => nodes(p.Plan))
        .filter((n) => n['Relation Name'] === 'organization_member' && n['Node Type'] !== 'ModifyTable');
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        if (scan['Node Type'] === 'Tid Scan') continue;
        expect(scan['Node Type']).toMatch(/Index (Only )?Scan/);
        for (const predicate of ['route =', 'organization_id =', 'member_account_id =', 'valid &&'])
          expect(scan['Index Cond']).toContain(predicate);
      }
      expect(scans.filter((scan) => scan['Node Type'] === 'Index Scan').length).toBeGreaterThan(0);
      const mutation = costOf({ statements: [], plans: mutationPlans });
      expect(mutation.rows).toBe(scheduled ? 4 : 2);
      return mutation;
    }

    // The harness captures only the whole command; the mutation statements are isolated from plans captured
    // at the same data after each growth step, as the median of the same number of runs.
    const mutations: { scale: number; cost: Cost }[] = [];
    const report = await checkGrowth(db, {
      name: `membership mutation (${scheduled ? 'scheduled' : 'ongoing'} member, ${role ?? 'removal'})`,
      scales: [256, 1024, 4096],
      bounds,
      async grow(_database, scale) {
        await seed(scale, past, scheduled);
        await exercise();
        const costs: Cost[] = [];
        for (let run = 0; run < 5; run++) {
          const observed = await capture(db, exercise);
          costs.push(mutationCostOf(observed.capture));
          console.info('membership mutation EXPLAIN', JSON.stringify({ scale, role, scheduled, cost: costs.at(-1) }));
        }
        mutations.push({ scale, cost: medianCost(costs) });
      },
      operation: exercise,
    });
    console.info('membership command', JSON.stringify(report.samples.map(({ scale, cost }) => [scale, cost.blocks])));
    for (const { cost } of report.samples) expect(cost.plans).toBe(report.samples[0]!.cost.plans);
    assertGrowth(mutations, bounds);
  }, 120_000);
}
