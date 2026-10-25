import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
let f: ActorFixture;
beforeAll(async () => {
  f = await actorFixture(pool);
});
afterAll(() => pool.end());

test('irrelevant organization denies do not veto either operand and unrelated scopes do not poison checks', async () => {
  await f.deny(f.irrelevantId);
  expect(await f.run()).toBe(true);
  expect(await f.run(f.delegated)).toBe(true);
  expect(
    await f.run({
      ...f.actor,
      scopes: ['openid', 'offline_access', 'subject:update', 'other:mounted', 'subject:read'],
    }),
  ).toBe(true);
  expect(await f.run({ ...f.actor, scopes: ['openid', 'subject:update'] })).toBe(false);
});

test('stale inverse supplies no roles; only matching groups require authoritative proof', async () => {
  const target = { ...f.resource, id: newId(f.resource.route) };
  await f.grant(f.staleId, 'owner', target);
  await f.pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    f.actorId,
  ]);
  await f.grant(f.staleId, 'owner');
  expect(await f.run()).toBe(false);
  await f.grant();
  await f.pool.query('ALTER TABLE access.organization_member RENAME TO actor_side_unavailable');
  try {
    expect(await f.run()).toBe(false);
  } finally {
    await f.pool.query('ALTER TABLE access.actor_side_unavailable RENAME TO organization_member');
  }
  await f.pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    f.staleId,
  ]);
  await f.pool.query('ALTER TABLE access.organization_member RENAME TO actor_side_unavailable');
  try {
    expect(await f.run()).toBe(true);
  } finally {
    await f.pool.query('ALTER TABLE access.actor_side_unavailable RENAME TO organization_member');
  }
});

test('newly matching denial without proof denies a direct grant on every resource-client attempt', async () => {
  const check = await f.prepare();
  expect(await withConnection(pool, check)).toBe(true);
  await f.deny(f.organizationId);
  expect(await withConnection(pool, check)).toBe(false);
  expect(await f.run()).toBe(false);
  expect(await f.run(f.delegated)).toBe(false);
  await pool.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    f.resource.route,
    f.resource.id,
    f.organizationId,
  ]);
});

test('role grants use the catalogue; matched organization and principal roles independently cap permission', async () => {
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await pool.query(
    `INSERT INTO access.resource_role_grant
    (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
    VALUES ($1,$2,$3,'owner','fixture.reader','(,)',$4)`,
    [f.resource.route, f.resource.id, f.organizationId, f.transactionId],
  );
  expect(await f.run()).toBe(true);
  expect(await f.run(f.delegated)).toBe(true);
  await pool.query('DELETE FROM access.organization_member WHERE route=$1 AND member_account_id=$2', [
    routeOf(f.organizationId),
    f.principalId,
  ]);
  expect(await f.run(f.delegated)).toBe(false);
  expect(await f.run()).toBe(true);
});

test('Realm roles require the server-owned anchored verifier; following and inverse admission are not roles', async () => {
  const r = await actorFixture(pool);
  const realmId = newId(0x789a);
  await r.admit(realmId, r.actorId, 'realm');
  await pool.query(`CREATE SCHEMA actor_side_realm`);
  await pool.query(`CREATE TABLE actor_side_realm.membership (
    route integer NOT NULL, realm_id uuid NOT NULL, account_id uuid NOT NULL,
    role text NOT NULL, valid tstzrange NOT NULL,
    PRIMARY KEY(route,realm_id,account_id,role,valid WITHOUT OVERLAPS))`);
  await pool.query(`CREATE INDEX realm_next_role ON actor_side_realm.membership
    (route,realm_id,account_id,role,lower(valid)) WHERE NOT lower_inf(valid)`);
  await pool.query(`CREATE TABLE actor_side_realm.following (
    route integer NOT NULL, realm_id uuid NOT NULL, account_id uuid NOT NULL,
    PRIMARY KEY(route,realm_id,account_id))`);
  await pool.query(`INSERT INTO actor_side_realm.following VALUES ($1,$2,$3)`, [routeOf(realmId), realmId, r.actorId]);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    r.resource.route,
    r.resource.id,
  ]);
  await r.grant(realmId, 'owner');
  expect(await r.run()).toBe(false);
  const anchors: string[] = [];
  const verified = r.permissions({
    realmRoleReader: async (client, input) => {
      anchors.push(`${input.realmId}/${input.accountId}`);
      // The supplied client is already the sole checkout. A verifier cannot open
      // another connection while reading its Realm anchor.
      await expect(withConnection(pool, async () => true)).rejects.toThrow('second connection');
      const result = await client.query(
        `SELECT r.role,m.valid IS NOT NULL AS member,
      COALESCE(m.valid,tstzrange($4::timestamptz,n.starts_at,'[)'))::text AS valid
      FROM (VALUES ('owner'),('member')) r(role)
      LEFT JOIN actor_side_realm.membership m ON m.route=$1 AND m.realm_id=$2 AND m.account_id=$3
        AND m.role=r.role AND m.valid @> $4::timestamptz
      LEFT JOIN LATERAL (SELECT lower(f.valid) starts_at FROM actor_side_realm.membership f
        WHERE f.route=$1 AND f.realm_id=$2 AND f.account_id=$3 AND f.role=r.role
        AND NOT lower_inf(f.valid) AND lower(f.valid)>$4::timestamptz ORDER BY lower(f.valid) LIMIT 1) n ON m.valid IS NULL`,
        [routeOf(input.realmId), input.realmId, input.accountId, input.at],
      );
      return result.rows;
    },
  });
  expect(await r.run(r.actor, verified)).toBe(false);
  await pool.query(`INSERT INTO actor_side_realm.membership VALUES ($1,$2,$3,'owner','(,)')`, [
    routeOf(realmId),
    realmId,
    r.actorId,
  ]);
  expect(await r.run(r.actor, verified)).toBe(true);
  expect(anchors.every((anchor) => anchor === `${realmId}/${r.actorId}`)).toBe(true);
  await r.grant();
  await pool.query('ALTER TABLE actor_side_realm.membership RENAME TO unavailable');
  try {
    expect(await r.run(r.actor, verified)).toBe(false);
  } finally {
    await pool.query('ALTER TABLE actor_side_realm.unavailable RENAME TO membership');
  }
  await r.deny(realmId);
  expect(await r.run(r.actor, verified)).toBe(false);
  await pool.query('DROP SCHEMA actor_side_realm CASCADE');
});

test('negative role proofs stop at future membership transitions; expired grants and denials stay native', async () => {
  const t = await actorFixture(pool);
  await t.deny(t.organizationId, 'member');
  const transition = (await pool.query("SELECT (clock_timestamp()+interval '350 milliseconds')::text AS at")).rows[0]
    .at;
  await pool.query(
    `UPDATE access.organization_member SET valid=tstzrange(NULL,$4::timestamptz,'[)')
    WHERE route=$1 AND organization_id=$2 AND member_account_id=$3`,
    [routeOf(t.organizationId), t.organizationId, t.actorId, transition],
  );
  await pool.query(
    `INSERT INTO access.organization_member
    (route,organization_id,member_account_id,role,valid,transaction_id)
    VALUES ($1,$2,$3,'member',tstzrange($5::timestamptz,'infinity','[)'),$4)`,
    [routeOf(t.organizationId), t.organizationId, t.actorId, t.transactionId, transition],
  );
  const check = await t.prepare();
  expect(await withConnection(pool, check)).toBe(true);
  await Bun.sleep(380);
  expect(await withConnection(pool, check)).toBe(false);
  expect(await t.run()).toBe(false);
});

test('incomplete admission coverage fails closed even with direct grants and no matching organization', async () => {
  const t = await actorFixture(pool);
  await pool.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
    routeOf(t.actorId),
    t.actorId,
  ]);
  expect(await t.run()).toBe(false);
});

test('actor and principal sharing one identity reuse the admitted role proof', async () => {
  const t = await actorFixture(pool);
  const requestId = newId(0x1234);
  await pool.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES ($1,$2,$3,$2,'(,)',$4)`,
    [routeOf(t.actorId), t.actorId, requestId, t.transactionId],
  );
  await t.deny(t.organizationId, 'member');
  expect(await t.run({ ...t.actor, requestedBy: `urn:rezics:request:${t.actorId}:${requestId}` })).toBe(true);
});

test('every newly matching group hit needs anchored proof even alongside a direct grant', async () => {
  const t = await actorFixture(pool);
  const check = await t.prepare();
  expect(await withConnection(pool, check)).toBe(true);
  await t.grant(t.organizationId, 'owner');
  expect(await withConnection(pool, check)).toBe(false);
  expect(await t.run()).toBe(true);
});
