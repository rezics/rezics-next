import { afterAll, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { resourceRoleHeld } from '../../src/access/index.ts';
import type { AccessClient } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
const route = 0x4567;
const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-10-02T00:00:00Z');
const at = new Date('2026-10-01T12:00:00Z');

function input() {
  return { resource: { route, id: newId(route) }, role: 'semantic.context.owner', accountId: newId(0xabcd), at };
}

async function grant(
  client: AccessClient,
  value: ReturnType<typeof input>,
  valid = '[2026-10-01,)',
  subjectRole = '',
  subjectKind = 'identity',
) {
  await client.query(
    `INSERT INTO access.resource_role_grant
     (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      value.resource.route,
      value.resource.id,
      subjectKind,
      value.accountId,
      subjectRole,
      value.role,
      valid,
      newId(route),
    ],
  );
}

test('a direct identity role grant valid at T is held', async () => {
  const value = input();
  // Tombstones retain grants; the data port must not require an active account.
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','deleted',$2)`,
    [0xabcd, value.accountId],
  );
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, value)).toBe(true);
  const longest = { ...input(), role: `a${'x'.repeat(127)}` };
  await grant(pool, longest);
  expect(await resourceRoleHeld(pool, longest)).toBe(true);
});

test('a grant is not held before its start or at its exclusive end', async () => {
  const value = input();
  await grant(pool, value, '[2026-10-01,2026-10-02)');
  for (const [instant, held] of [
    [new Date(start.getTime() - 1), false],
    [start, true],
    [new Date(end.getTime() - 1), true],
    [end, false],
    [new Date(end.getTime() + 1), false],
  ] as const)
    expect(await resourceRoleHeld(pool, { ...value, at: instant })).toBe(held);
});

test('a revoked grant is not held after revocation', async () => {
  const value = input();
  await grant(pool, value);
  await pool.query(
    `UPDATE access.resource_role_grant SET valid=tstzrange(lower(valid),$3,'[)')
     WHERE route=$1 AND resource_id=$2`,
    [route, value.resource.id, end],
  );
  expect(await resourceRoleHeld(pool, value)).toBe(true);
  expect(await resourceRoleHeld(pool, { ...value, at: end })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, at: new Date(end.getTime() + 1) })).toBe(false);
});

test("group-held and active-accounts grants are not reported as the account's", async () => {
  const value = input();
  for (const role of ['owner', 'member']) await grant(pool, value, '[2026-10-01,)', role);
  await grant(
    pool,
    { ...value, accountId: '00000000-0000-0000-0000-000000000000' },
    '[2026-10-01,)',
    '',
    'active_accounts',
  );
  expect(await resourceRoleHeld(pool, value)).toBe(false);
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, value)).toBe(true);
});

test('another role resource or account is not held', async () => {
  const value = input();
  await grant(pool, value);
  expect(await resourceRoleHeld(pool, { ...value, role: 'semantic.context.editor' })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, resource: { route, id: newId(route) } })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, resource: { route: 0x4568, id: newId(0x4568) } })).toBe(false);
  expect(await resourceRoleHeld(pool, { ...value, accountId: newId(0xabcd) })).toBe(false);
});

test("the read sees the caller's transaction snapshot and opens no connection", async () => {
  const value = input();
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
      `UPDATE access.resource_role_grant SET valid=tstzrange(lower(valid),$3,'[)')
       WHERE route=$1 AND resource_id=$2`,
      [route, value.resource.id, at],
    );
    expect(await resourceRoleHeld(reader, value)).toBe(true);
    const uncommitted = input();
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
  const value = input();
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
    ...[new Date(NaN), new Date(Infinity), at.toISOString(), at.getTime(), null, {}].map((at) => ({ ...value, at })),
  ];
  for (const candidate of invalid)
    await expect(resourceRoleHeld(client, candidate as Parameters<typeof resourceRoleHeld>[1])).rejects.toBeInstanceOf(
      TypeError,
    );
  expect(reads).toBe(0);
});
