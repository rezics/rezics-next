import { afterAll, expect, test } from 'bun:test';
import { grantAccountRole } from '../../src/access/account-role-grant.ts';
import { ResourceAccessWriteDeniedError } from '../../src/access/resource-denials.ts';
import { runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const route = 0x42a0;
const at = '2026-01-20T12:00:00.000Z';
const options = { partition: partitionOf(route), clock: () => new Date(at) };
const role = 'commerce.payout.owner';
const event = { type: 'com.rezics.fixture.created.v1', data: {} };
const account = (accountRoute = route) => ({ route: accountRoute, id: newId(accountRoute) });
const grants = async (id: string) =>
  (
    await pool.query(
      'SELECT route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid::text, transaction_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY valid',
      [route, id],
    )
  ).rows;
afterAll(() => pool.end());

test('a system command grants the account its catalogue role from exactly T and repeat calls add no row', async () => {
  const anchor = account();
  await runCommand(pool, options, async (tx) => {
    await grantAccountRole(tx, { account: anchor, role });
    await grantAccountRole(tx, { account: anchor, role });
    const result = await tx.query(
      `SELECT lower(valid)=$3::timestamptz AS starts, lower_inc(valid) AS inclusive,
              upper_inf(valid) AS open, valid @> $3::timestamptz AS current
       FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2`,
      [route, anchor.id, at],
    );
    expect(result.rows).toEqual([{ starts: true, inclusive: true, open: true, current: true }]);
    return { value: null, events: [event] };
  });
  const before = await grants(anchor.id);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    route,
    resource_id: anchor.id,
    subject_kind: 'identity',
    subject_id: anchor.id,
    subject_role: '',
    grant_role: role,
  });
  await runCommand(pool, { ...options, clock: () => new Date('2026-01-21T12:00:00Z') }, async (tx) => {
    await grantAccountRole(tx, { account: anchor, role });
    return { value: null, events: [event] };
  });
  expect(await grants(anchor.id)).toEqual(before);
});

test('existing unbounded and finite grants current at T remain unchanged', async () => {
  for (const valid of ['(,)', '[2026-01-01,2026-02-01)']) {
    const anchor = account();
    await pool.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
       VALUES ($1,$2,$2,$3,$4,$2)`,
      [route, anchor.id, role, valid],
    );
    const before = await grants(anchor.id);
    await runCommand(pool, options, async (tx) => {
      await grantAccountRole(tx, { account: anchor, role });
      return { value: null, events: [event] };
    });
    expect(await grants(anchor.id)).toEqual(before);
  }
});

test('closed history permits a new grant starting at its exclusive end', async () => {
  const anchor = account();
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
     VALUES ($1,$2,$2,$3,tstzrange(NULL,$4,'()'),$2)`,
    [route, anchor.id, role, at],
  );
  await runCommand(pool, options, async (tx) => {
    await grantAccountRole(tx, { account: anchor, role });
    return { value: null, events: [event] };
  });
  expect(await grants(anchor.id)).toHaveLength(2);
});

test('unknown catalogue roles and anchors outside the partition are refused without writing', async () => {
  const anchor = account();
  for (const input of [
    { account: anchor, role: 'commerce.payout.unknown' },
    { account: anchor, role: 'toString' },
    { account: account(route + 16), role },
    { account: { ...anchor, route: route + 1 }, role },
  ]) {
    await expect(
      runCommand(pool, options, async (tx) => {
        await grantAccountRole(tx, input);
        return { value: null, events: [event] };
      }),
    ).rejects.toBeInstanceOf(ResourceAccessWriteDeniedError);
    expect(await grants(anchor.id)).toEqual([]);
    expect(
      (
        await pool.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
          input.account.route,
          input.account.id,
        ])
      ).rows,
    ).toEqual([]);
  }
});

test('an anchor on another route in the command partition is allowed and rolls back with the command', async () => {
  const anchor = account(route + 1);
  const failure = new Error('Abort the command');
  await expect(
    runCommand(pool, options, async (tx) => {
      await grantAccountRole(tx, { account: anchor, role });
      expect(
        (
          await tx.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
            anchor.route,
            anchor.id,
          ])
        ).rows,
      ).toHaveLength(1);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(
    (
      await pool.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        anchor.route,
        anchor.id,
      ])
    ).rows,
  ).toEqual([]);
});

test('a connection and an expired command transaction cannot write a grant', async () => {
  const anchor = account();
  await expect(grantAccountRole(pool, { account: anchor, role })).rejects.toBeInstanceOf(
    ResourceAccessWriteDeniedError,
  );
  let expired: CommandTransaction | undefined;
  await runCommand(pool, options, async (tx) => {
    expired = tx;
    return { value: null, events: [event] };
  });
  await expect(grantAccountRole(expired!, { account: anchor, role })).rejects.toBeInstanceOf(
    ResourceAccessWriteDeniedError,
  );
  expect(await grants(anchor.id)).toEqual([]);
});
