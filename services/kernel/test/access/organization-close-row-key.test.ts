import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createOrganizationCloseRunner } from '../../src/access/organization-close-work.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access });
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const runner = createOrganizationCloseRunner({ pool });
const workflow = DBOS.registerWorkflow(
  async (org: string, sequence: number) =>
    DBOS.runStep(() => runner.step(org, sequence), { name: 'close-row-key.page', retriesAllowed: false }),
  { name: 'close-row-key' },
);
beforeAll(async () => {
  DBOS.setConfig({
    name: 'close-row-key-test',
    systemDatabaseUrl: process.env.DATABASE_URL!,
    systemDatabaseSchemaName: 'dbos',
    runMigrations: false,
    logLevel: 'error',
  });
  await DBOS.launch();
});
afterAll(async () => {
  await DBOS.shutdown();
  await pool.end();
});
const key = () => crypto.randomUUID();
const step = async (org: string, sequence: number) => (await DBOS.startWorkflow(workflow)(org, sequence)).getResult();
type MemberRow = { row_key: string; member_account_id: string };
async function rows(org: string) {
  return (
    await pool.query<MemberRow>(
      'SELECT row_key, member_account_id FROM access.organization_member WHERE route=$1 AND organization_id=$2 ORDER BY row_key',
      [routeOf(org), org],
    )
  ).rows;
}
async function checkpoint(org: string) {
  return (
    await pool.query('SELECT * FROM access.organization_close WHERE route=$1 AND organization_id=$2', [
      routeOf(org),
      org,
    ])
  ).rows[0];
}
async function fixture(memberCount: number) {
  const owner = newId(0x31a1),
    org = newId(0x31b1);
  const members = Array.from({ length: memberCount }, () => newId(0x31a1));
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id",
    [routeOf(owner), [owner, ...members]],
  );
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
  // Three disjoint historical intervals and one current interval per member.
  // No writer supplies a row key, including the native creation above.
  await pool.query(
    `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
     SELECT $1,$2,id,'member',tstzrange('2000-01-01'::timestamptz + n * interval '1 day',
       CASE WHEN n < 3 THEN '2000-01-01'::timestamptz + (n+1) * interval '1 day' END,'[)'),id
     FROM unnest($3::uuid[]) id CROSS JOIN generate_series(0,3) n`,
    [routeOf(org), org, members],
  );
  await pool.query(
    'INSERT INTO access.lifecycle_membership_slot(route,organization_id,member_account_id,reservation_id,transaction_id) SELECT $1,$2,id,id,id FROM unnest($3::uuid[]) id',
    [routeOf(org), org, members],
  );
  await pool.query(
    "INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id) SELECT $1,id,'organization',$2,id,id FROM unnest($3::uuid[]) id",
    [routeOf(owner), org, members],
  );
  await pool.query(
    "INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id) SELECT $1,id,id,$2,'membership',id FROM unnest($3::uuid[]) id",
    [routeOf(owner), org, members],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30000 },
    { accountId: owner, clientId: 'row-key-test', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  await commands.tombstone({ actor, deadline: Date.now() + 30000 }, { accountId: org, key: key() });
  return { org, members: [owner, ...members] };
}

function independent(work: Record<string, unknown>, members: string[]) {
  for (const value of Object.values(work)) expect(members).not.toContain(value);
}

test('close stores only an independent cursor and every membership gets a random owner-unique row key by default', async () => {
  const { org, members } = await fixture(2);
  const columns = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='access' AND table_name='organization_close' ORDER BY ordinal_position",
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    'route',
    'organization_id',
    'receipt_id',
    'handle',
    'step',
    'complete',
    'handle_key',
    'cursor_row_key',
  ]);
  // organization_id is the owner anchor; the remaining UUIDs are receipt and cursor keys.
  expect(columns.rows.filter((row) => row.data_type === 'uuid').map((row) => row.column_name)).toEqual([
    'organization_id',
    'receipt_id',
    'cursor_row_key',
  ]);
  const before = await rows(org);
  expect(before).toHaveLength(9);
  expect(new Set(before.map((row) => row.row_key)).size).toBe(before.length);
  for (const row of before) {
    expect(row.row_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(members).not.toContain(row.row_key);
  }
  const column = await pool.query(
    "SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema='access' AND table_name='organization_member' AND column_name='row_key'",
  );
  expect(column.rows[0]).toEqual({ column_default: 'gen_random_uuid()', is_nullable: 'NO' });
  await expect(
    pool.query(
      "INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id,row_key) VALUES($1,$2,$3,'member','[1990-01-01,1991-01-01)',$3,$4)",
      [routeOf(org), org, newId(0x31a1), before[0]!.row_key],
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'organization_member_row_key' });
  independent(await checkpoint(org), members);
  expect(await step(org, 0)).toEqual({ count: 9, next: null });
  expect(await checkpoint(org)).toMatchObject({ complete: true, cursor_row_key: null });
  independent(await checkpoint(org), members);
});

for (const reset of [false, true]) {
  test(`native DBOS close removes more than three pages exactly once, replaying committed pages${reset ? ' and resetting the cursor' : ''}`, async () => {
    const { org, members } = await fixture(101);
    const initial = await rows(org);
    expect(initial).toHaveLength(405);
    const removed = new Set<string>();
    let total = 0;
    let sequence: number | null = 0;
    while (sequence !== null) {
      const before = await rows(org);
      const expected = before.slice(0, 100);
      const result = await step(org, sequence);
      expect(result.count).toBe(expected.length);
      expect(await rows(org)).toEqual(before.slice(100));
      for (const row of expected) {
        expect(removed.has(row.row_key)).toBe(false);
        removed.add(row.row_key);
      }
      const work = await checkpoint(org);
      expect(work.cursor_row_key).toBe(result.next === null ? null : expected.at(-1)!.row_key);
      independent(work, members);
      const receipt = await pool.query(
        "SELECT response FROM core.receipt WHERE partition_no=$1 AND command_kind='access.organization-close.page' AND idempotency_key=$2",
        [routeOf(org)! >>> 4, `${routeOf(org)}:organization-close:${org}:${sequence}`],
      );
      expect(receipt.rows[0].response.members.sort()).toEqual(
        [...new Set(expected.map((row) => row.member_account_id))].sort(),
      );
      const after = await rows(org);
      // A fresh DBOS invocation must hit the native receipt, even after completion.
      expect(await step(org, sequence)).toEqual(result);
      expect(await rows(org)).toEqual(after);
      expect(await checkpoint(org)).toEqual(work);
      total += result.count;
      if (reset && sequence === 1) {
        await pool.query(
          'UPDATE access.organization_close SET cursor_row_key=NULL WHERE route=$1 AND organization_id=$2',
          [routeOf(org), org],
        );
        expect(await checkpoint(org)).toMatchObject({ step: 2, complete: false, cursor_row_key: null });
      }
      sequence = result.next;
    }
    expect(total).toBe(initial.length);
    expect(removed.size).toBe(initial.length);
    expect(await rows(org)).toEqual([]);
    expect(await checkpoint(org)).toMatchObject({ step: 5, complete: true, cursor_row_key: null });
    expect(
      (
        await pool.query(
          'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2',
          [routeOf(org), org],
        )
      ).rows.every((row) => row.terminal),
    ).toBe(true);
    await runner.continueCommitted(org);
  }, 120000);
}

test('a failed checkpoint rolls back the page deletions and terminal slots together', async () => {
  const { org } = await fixture(26);
  const before = await rows(org);
  const work = await checkpoint(org);
  await pool.query(`CREATE FUNCTION access.reject_close_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.organization_id::text = TG_ARGV[0] THEN RAISE EXCEPTION 'checkpoint refused'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER reject_close_checkpoint BEFORE UPDATE ON access.organization_close
    FOR EACH ROW EXECUTE FUNCTION access.reject_close_checkpoint('${org}')`);
  try {
    await expect(step(org, 0)).rejects.toThrow('checkpoint refused');
    expect(await rows(org)).toEqual(before);
    expect(await checkpoint(org)).toEqual(work);
    expect(
      (
        await pool.query(
          'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2',
          [routeOf(org), org],
        )
      ).rows.every((row) => !row.terminal),
    ).toBe(true);
  } finally {
    await pool.query('DROP TRIGGER reject_close_checkpoint ON access.organization_close');
    await pool.query('DROP FUNCTION access.reject_close_checkpoint()');
  }
  expect(await step(org, 0)).toEqual({ count: 100, next: 1 });
  expect(await step(org, 1)).toEqual({ count: 5, next: null });
});

test('an exactly full final page is followed by an empty page that clears the cursor', async () => {
  const { org } = await fixture(25);
  await pool.query('DELETE FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND row_key=$3', [
    routeOf(org),
    org,
    (await rows(org))[0]!.row_key,
  ]);
  expect(await step(org, 0)).toEqual({ count: 100, next: 1 });
  expect(await rows(org)).toEqual([]);
  expect((await checkpoint(org)).cursor_row_key).not.toBeNull();
  expect(await step(org, 1)).toEqual({ count: 0, next: null });
  expect(await checkpoint(org)).toMatchObject({ complete: true, cursor_row_key: null });
});
