import { afterAll, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { resourceRoleHeld } from '../../src/access/index.ts';
import { authoritativeTimeValue, mintReadTime } from '../../src/command/command.ts';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const route = 0x4567;
async function input(client: AccessClient = pool) {
  return {
    resource: { route, id: newId(route) },
    role: 'semantic.context.owner',
    accountId: newId(0xabcd),
    at: await mintReadTime(client),
  };
}

async function grant(
  client: AccessClient,
  value: Awaited<ReturnType<typeof input>>,
  {
    start = '-1 second',
    end = null,
    subjectRole = '',
    subjectKind = 'identity',
  }: {
    start?: string | null;
    end?: string | null;
    subjectRole?: string;
    subjectKind?: string;
  } = {},
) {
  await client.query(
    `INSERT INTO access.resource_role_grant
     (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,
       tstzrange($7::timestamptz + $8::interval,$7::timestamptz + $9::interval,'[)'),$10)`,
    [
      value.resource.route,
      value.resource.id,
      subjectKind,
      value.accountId,
      subjectRole,
      value.role,
      authoritativeTimeValue(value.at),
      start,
      end,
      newId(route),
    ],
  );
}

test('a direct identity role grant valid at T is held', async () => {
  const value = await input();
  // Tombstones retain grants; the data port must not require an active account.
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','deleted',$2)`,
    [0xabcd, value.accountId],
  );
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, value)).toBe(true);
  const longest = { ...(await input()), role: `a${'x'.repeat(127)}` };
  await grant(pool, longest);
  expect(await resourceRoleHeld(pool, longest)).toBe(true);
});

test('a grant is not held before its start or at its exclusive end', async () => {
  for (const [start, end, held] of [
    ['1 second', null, false],
    ['0 seconds', '1 second', true],
    ['-1 second', '0 seconds', false],
    ['-2 seconds', '-1 second', false],
  ] as const) {
    const value = await input();
    await grant(pool, value, { start, end });
    expect(await resourceRoleHeld(pool, value)).toBe(held);
  }
});

test('a grant ending one microsecond after T is held and one ending exactly at T is not', async () => {
  const value = await input();
  await grant(pool, value, { end: '1 microsecond' });
  expect(await resourceRoleHeld(pool, value)).toBe(true);
  const ended = { ...value, resource: { route, id: newId(route) } };
  await grant(pool, ended, { end: '0 seconds' });
  expect(await resourceRoleHeld(pool, ended)).toBe(false);
});

test('a revoked grant is not held after revocation', async () => {
  const value = await input();
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, value)).toBe(true);
  await pool.query(
    `UPDATE access.resource_role_grant SET valid=tstzrange(lower(valid),$3::timestamptz,'[)')
     WHERE route=$1 AND resource_id=$2`,
    [route, value.resource.id, authoritativeTimeValue(value.at)],
  );
  expect(await resourceRoleHeld(pool, value)).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, at: await mintReadTime(pool) })).toBe(false);
});

test("group-held and active-accounts grants are not reported as the account's", async () => {
  const value = await input();
  for (const subjectRole of ['owner', 'member']) await grant(pool, value, { subjectRole });
  await grant(
    pool,
    { ...value, accountId: '00000000-0000-0000-0000-000000000000' },
    { subjectKind: 'active_accounts' },
  );
  expect(await resourceRoleHeld(pool, value)).toBe(false);
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, value)).toBe(true);
});

test('another role resource or account is not held', async () => {
  const value = await input();
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, { ...value, role: 'semantic.context.editor' })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, resource: { route, id: newId(route) } })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, resource: { route: 0x4568, id: newId(0x4568) } })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, accountId: newId(0xabcd) })).toBe(false);
});

test("the read sees the caller's transaction snapshot and opens no connection", async () => {
  const value = await input();
  await grant(pool, value);
  const reader = await pool.connect();
  const writer = await pool.connect();
  const connect = spyOn(pool, 'connect');
  try {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const query = spyOn(reader, 'query');
    try {
      expect(await resourceRoleHeld(reader, value)).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
    await writer.query(
      `UPDATE access.resource_role_grant SET valid=tstzrange(lower(valid),$3::timestamptz,'[)')
       WHERE route=$1 AND resource_id=$2`,
      [route, value.resource.id, authoritativeTimeValue(value.at)],
    );
    expect(await resourceRoleHeld(reader, value)).toBe(true);
    const uncommitted = await input(reader);
    await grant(reader, uncommitted);
    expect(await resourceRoleHeld(reader, uncommitted)).toBe(true);
    await reader.query('COMMIT');
    expect(await resourceRoleHeld(reader, value)).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
    await reader.query('ROLLBACK');
    reader.release();
    writer.release();
  }
});

test('invalid input throws TypeError before any read', async () => {
  const value = await input();
  let reads = 0;
  const client: AccessClient = {
    query: (() => {
      reads++;
      throw new Error('Unexpected read');
    }) as AccessClient['query'],
  };
  const invalid: unknown[] = [
    null,
    undefined,
    {},
    { ...value, resource: null },
    { ...value, resource: { route: route + 1, id: value.resource.id } },
    { ...value, resource: { route: null, id: 'invalid' } },
    { ...value, resource: { route, id: 'invalid' } },
    ...['invalid', '00000000-0000-4000-8000-000000000000', '', null, 7].map((accountId) => ({ ...value, accountId })),
    ...['', 'Owner', 'semantic:owner', 'a/b', 'a b', 'a\n', `a${'x'.repeat(128)}`, null, 7].map((role) => ({
      ...value,
      role,
    })),
    ...[
      new Date(),
      new Date(NaN),
      new Date(Infinity),
      authoritativeTimeValue(value.at),
      Date.now(),
      null,
      undefined,
      {},
      { ...value.at },
    ].map((at) => ({ ...value, at })),
  ];
  for (const candidate of invalid)
    await expect(resourceRoleHeld(client, candidate as Parameters<typeof resourceRoleHeld>[1])).rejects.toBeInstanceOf(
      TypeError,
    );
  expect(reads).toBe(0);
});
