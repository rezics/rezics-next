import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals, LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(83),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const key = () => Bun.randomUUIDv7();
async function existing(kind = 'actor', state = 'active', fenced = false) {
  const accountId = newId(0xb355);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [routeOf(accountId), accountId, kind, state, fenced, key()],
  );
  return accountId;
}
const history = async (id: string) =>
  (
    await pool.query(
      `SELECT * FROM access.resource_grant
  WHERE route=$1 AND resource_id=$2 ORDER BY subject_id, action, valid`,
      [routeOf(id), id],
    )
  ).rows;
const account = async (id: string) =>
  (await pool.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(id), id])).rows;

test('deployment upgrade is a resumable one-account native command with no duplicate or principal grant', async () => {
  const id = await existing();
  const untouched = await existing();
  const before = await account(id);
  const input = { accountId: id, key: key() };
  const first = await internal.installSelfReadGrant(input);
  expect(first.value).toEqual({ accountId: id, installed: 1 });
  expect(await internal.installSelfReadGrant(input)).toEqual({ ...first, replayed: true });
  const retained = await history(id);
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    route: routeOf(id),
    resource_id: id,
    subject_kind: 'identity',
    subject_id: id,
    subject_role: '',
    action: 'account:read',
    transaction_id: first.transactionId,
  });
  expect(retained[0].valid).toBe('(,)');
  const retries = await Promise.all([
    internal.installSelfReadGrant({ accountId: id, key: key() }),
    internal.installSelfReadGrant({ accountId: id, key: key() }),
  ]);
  expect(retries.map((result) => result.value.installed)).toEqual([0, 0]);
  expect(await history(id)).toEqual(retained);
  expect(await account(id)).toEqual(before);
  expect(await history(untouched)).toEqual([]);
});

test('deployment upgrade retains bounded and expired native history and unrelated grants verbatim', async () => {
  for (const valid of ['[2020-01-01,2021-01-01)', '[2090-01-01,2091-01-01)', '(,)']) {
    const id = await existing();
    for (const action of ['account:read', 'account:update', 'account:delete'])
      await pool.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
        VALUES ($1,$2,$2,$3,$4,$5)`,
        [routeOf(id), id, action, valid, key()],
      );
    const before = await history(id);
    const result = await internal.installSelfReadGrant({ accountId: id, key: key() });
    expect(result.value.installed).toBe(0);
    expect(await history(id)).toEqual(before);
  }
});

test('deployment upgrade rejects ineligible accounts without reviving authentication or adding grants', async () => {
  for (const [kind, state, fenced] of [
    ['organization', 'active', false],
    ['actor', 'pending', false],
    ['actor', 'suspended', false],
    ['actor', 'deleted', false],
    ['actor', 'active', true],
  ] as const) {
    const id = await existing(kind, state, fenced);
    const before = await account(id);
    await expect(internal.installSelfReadGrant({ accountId: id, key: key() })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
    expect(await history(id)).toEqual([]);
    expect(await account(id)).toEqual(before);
  }
});
