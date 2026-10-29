import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { newId, routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createOrganizationCloseRunner } from '../../src/access/organization-close-work.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import {
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  type GrowthDatabase,
  type ReportSample,
} from '../support/growth.ts';

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
  if (history) {
    const prefix = Math.floor((count * 2 - 200) / 100) * 100;
    const rowKey = (position: number) => `00000000-0000-4000-8000-${position.toString(16).padStart(12, '0')}`;
    const preceding = (position: number) => rowKey(position > prefix ? position + 100 : position);
    // Both intervals of preceding members come before the fixed page. Any
    // incomplete prefix page and the measured members' repeated history follow it.
    // The owner's native creation row is first, so its random default cannot
    // displace a measured member or release that member during preparation.
    await db.admin.query(
      `UPDATE access.organization_member m
       SET row_key = CASE WHEN lower(m.valid) = '2000-01-01'::timestamptz THEN o.history_key ELSE o.current_key END
       FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) o(member_id, current_key, history_key)
       WHERE m.route=$1 AND m.organization_id=$2 AND m.member_account_id=o.member_id`,
      [
        organizationRoute,
        org,
        [owner, ...members],
        [rowKey(1), ...members.map((_, i) => (i < 100 ? rowKey(prefix + i + 1) : preceding(2 * (i - 100) + 2)))],
        [rowKey(1), ...members.map((_, i) => (i < 100 ? rowKey(count * 2 + 101 + i) : preceding(2 * (i - 100) + 3)))],
      ],
    );
  }
  return { owner, org, measuredMembers: members.slice(0, 100) };
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
  let targets: { owner: string; org: string; measuredMembers: string[]; sequence: number; pages: number }[] = [];
  const nativePlans: { scale: number; organizationId: string; sequence: number; plans: unknown[] }[] = [];
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
  async function operation(_database: GrowthDatabase, scale: number) {
    const { org, sequence, measuredMembers } = targets.shift()!;
    // Read the runner's exact row-key neighbourhood without altering its work.
    const selected = await db.admin.query<{ row_key: string; member_account_id: string; reserved: boolean }>(
      `WITH batch AS (
         SELECT m.row_key, m.member_account_id
         FROM access.organization_close w JOIN access.organization_member m
           ON m.route=w.route AND m.organization_id=w.organization_id
         WHERE w.route=$1 AND w.organization_id=$2
           AND m.row_key > COALESCE(w.cursor_row_key, '00000000-0000-0000-0000-000000000000'::uuid)
         ORDER BY m.row_key LIMIT 100
       )
       SELECT b.*, EXISTS (
         SELECT 1 FROM access.membership_inverse i
         JOIN access.lifecycle_coordination c ON c.route=i.route AND c.account_id=i.account_id
           AND c.reservation_id=i.reservation_id AND c.transaction_id=i.transaction_id
         JOIN access.lifecycle_membership_slot s ON s.route=$1 AND s.organization_id=$2
           AND s.member_account_id=i.account_id AND s.reservation_id=i.reservation_id AND NOT s.terminal
         WHERE i.route=$3 AND i.account_id=b.member_account_id AND i.kind='organization' AND i.group_id=$2
           AND c.related_account_id=$2 AND c.purpose='membership'
       ) AS reserved FROM batch b ORDER BY b.row_key`,
      [organizationRoute, org, memberRoute],
    );
    const selectedRows = selected.rows.length;
    const distinctMembers = new Set(selected.rows.map((row) => row.member_account_id)).size;
    expect(selectedRows).toBe(100);
    expect(distinctMembers).toBe(100);
    expect(selected.rows.map((row) => row.member_account_id).sort()).toEqual([...measuredMembers].sort());
    expect(selected.rows.every((row) => row.reserved)).toBe(true);
    // Retain the existing capture's native auto_explain notices for diagnostics;
    // do not issue another execution or alter any statement in the capture.
    const client = await db.pool.connect();
    const plans: unknown[] = [];
    const retainPlan = (notice: { message?: string | undefined }) => {
      const marker = 'plan:\n';
      const start = notice.message?.indexOf(marker) ?? -1;
      if (start >= 0) plans.push(JSON.parse(notice.message!.slice(start + marker.length)));
    };
    client.on('notice', retainPlan);
    client.release(); // The measured runner uses this pool's single connection.
    try {
      expect(await runner.step(org, sequence)).toEqual({ count: 100, next: sequence + 1 });
    } finally {
      client.removeListener('notice', retainPlan);
      nativePlans.push({ scale, organizationId: org, sequence, plans });
    }
    const receipt = await db.admin.query(
      `SELECT response FROM core.receipt WHERE partition_no=$1
       AND command_kind='access.organization-close.page' AND idempotency_key=$2`,
      [organizationRoute >>> 4, `${organizationRoute}:organization-close:${org}:${sequence}`],
    );
    expect(receipt.rows[0].response.members.sort()).toEqual([...measuredMembers].sort());
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int n FROM access.organization_member WHERE route=$1 AND organization_id=$2',
          [routeOf(org), org],
        )
      ).rows[0].n,
    ).toBeGreaterThan(100);
    return { selectedRows, distinctMembers };
  }
  function recordEvidence(samples: readonly ReportSample[]) {
    for (const sample of samples)
      sample.statementRepetitions.forEach((statements, repetition) => {
        const selectedRows = sample.counted!.selectedRows!.repetitions[repetition]!;
        const distinctMembers = sample.counted!.distinctMembers!.repetitions[repetition]!;
        const releaseCalls = statements
          .filter(({ statement }) => statement.includes('INSERT INTO access.membership_inverse_terminal'))
          .reduce((sum, statement) => sum + statement.count, 0);
        console.info('organization cleanup page evidence', {
          scale: sample.scale,
          selectedRows,
          distinctMembers,
          releaseCalls,
        });
        expect(selectedRows).toBe(100);
        expect(distinctMembers).toBe(100);
        expect(releaseCalls).toBeGreaterThan(0);
        expect(releaseCalls).toBeLessThanOrEqual(distinctMembers);
        expect(distinctMembers).toBeLessThanOrEqual(100);
      });
  }
  const report = await checkGrowth(db, {
    name: 'organization cleanup step',
    scales: [256, 1024, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    counted: {
      read: (value) => value as Awaited<ReturnType<typeof operation>>,
      limits: { selectedRows: 100, distinctMembers: 100 },
      bounds: { selectedRows: 'constant', distinctMembers: 'constant' },
    },
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
    async warmup(database, scale) {
      await earlierPages();
      await operation(database, scale);
    },
    operation,
  }).catch((error: unknown) => {
    if (error instanceof GrowthBoundError) {
      const samples = error.samples as readonly ReportSample[];
      const directory = new URL('../../../../.temp/', import.meta.url);
      mkdirSync(directory, { recursive: true });
      const evidence = new URL('organization-close-growth-plans.json', directory);
      writeFileSync(evidence, JSON.stringify({ samples, nativePlans }, null, 2));
      console.error('organization cleanup statement repetitions and native plans', evidence.pathname);
      recordEvidence(samples);
    }
    throw error;
  });
  recordEvidence(report.samples);
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
}, 240000);
