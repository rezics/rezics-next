import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver, worker } from './community-driver.ts';
import { createProductionAccess } from './membership-fixture.ts';

let driver: CommunityDriver;
let fixture: Fixture;
let deletion: ReturnType<typeof accountDeletionRuntime>;
let growth: GrowthDatabase;
let production: Awaited<ReturnType<typeof createProductionAccess>>;
let membership: ReturnType<typeof createRealmMembership>;
let member: { accountId: string; bearer: string };
let realms: string[];
const reservations = new Map<string, string>();
const scopes = ['realm:manage', 'realm:join', 'realm:read', 'realm:participate', 'access:grant'];

async function call(method: 'POST' | 'DELETE' | 'PUT', path: string, body?: unknown, actor?: Account) {
  const response = await driver.request({
    actor: actor ?? fixture.owner,
    method,
    path,
    key: JSON.stringify(crypto.randomUUID()),
    ...(body === undefined ? {} : { body }),
  });
  expect(response.status, await response.clone().text()).toBe(method === 'POST' ? 201 : 200);
  return response.json();
}

async function publish(realmId: string, accountId: string, role: 'member' | null) {
  const pool = communityFixtureRuntime().system.database.pool;
  const initiator = role === null ? accountId : fixture.owner.id;
  const actor = await production.authenticate(pool, initiator, scopes);
  const account = await readAccount(pool, routeOf(initiator)!, initiator);
  if (!account) throw new Error('Membership fixture account is missing');
  const reservationId = reservations.get(`${realmId}:${accountId}`) ?? newId(routeOf(accountId)!);
  reservations.set(`${realmId}:${accountId}`, reservationId);
  await membership.publish(
    { actor, account, deadline: Date.now() + 30_000 },
    {
      kind: 'membership',
      principal: { kind: 'realm', id: realmId },
      memberAccountId: accountId,
      role,
      authorization: 'authenticated-membership-fixture',
    },
    { accountId, principal: { kind: 'realm', id: realmId }, reservationId },
    crypto.randomUUID(),
  );
}

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  deletion = accountDeletionRuntime(system);
  member = await deletion.person();
  production = await createProductionAccess({ actions: [...system.actions.keys()] });
  membership = createRealmMembership({ pool: system.database.pool, access: production.access });
  const changeMembership = async (realmId: string, account: Account, join: boolean) => {
    const response = await driver.request({
      actor: join ? fixture.owner : account,
      method: join ? 'POST' : 'DELETE',
      path: `/v1/realms/${realmId}/${join ? 'members' : 'membership'}`,
      key: JSON.stringify(crypto.randomUUID()),
      ...(join ? { body: { accountId: account.id } } : {}),
    });
    if (response.status !== 202) throw new Error(`Membership setup failed: ${await response.text()}`);
    await driver.settle();
  };
  realms = [];
  for (let index = 0; index < 4; index++) {
    const { space } = await call('POST', '/v1/spaces', { title: `Erasure host ${index}` });
    const { realm } = await call('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: `Erasure Realm ${index}`,
      visibility: 'public',
      contextId: fixture.contextId,
    });
    realms.push(realm.realmId);
    await call('POST', '/v1/grants', {
      resource: { route: routeOf(realm.realmId), id: realm.realmId },
      subject: { kind: 'account', id: member.accountId },
      actions: ['realm:join'],
      valid: '(,)',
    });
    await changeMembership(realm.realmId, { id: member.accountId, bearer: member.bearer }, true);
    await changeMembership(realm.realmId, fixture.outsider, true);
  }
  await changeMembership(realms[2]!, { id: member.accountId, bearer: member.bearer }, false);
  // The ban removes the fourth interval through the ordinary native workflow.
  await call('PUT', `/v1/realms/${realms[3]}/bans/${member.accountId}`, { reason: 'Erasure fixture ban' });
  await driver.settle();
  for (const realmId of realms) await drainEffects(system.database.pool, partitionOf(routeOf(realmId)!));
}, 180_000);

afterAll(async () => {
  await growth?.close();
  await closeCommunityDrivers();
});

async function locator() {
  return (
    await communityFixtureRuntime().system.database.pool.query<{ realm_id: string; realm_route: number }>(
      'SELECT realm_id::text, realm_route FROM community.member_locator WHERE route=$1 AND account_id=$2 ORDER BY realm_id',
      [routeOf(member.accountId), member.accountId],
    )
  ).rows;
}

// Run this before deleting the shared account so both projection and migration see historical intervals.
test.serial(
  'the member locator lists every Realm the account joined, including ones left before deletion',
  async () => {
    expect((await locator()).map((row) => row.realm_id)).toEqual([...realms].sort());
    for (const row of await locator()) expect(row.realm_route).toBe(routeOf(row.realm_id)!);
    const pool = communityFixtureRuntime().system.database.pool;
    const migrationPaths = [
      ...new Bun.Glob('db/community/migrations/*_member_locator.sql').scanSync({ cwd: `${import.meta.dir}/../..` }),
    ];
    expect(migrationPaths).toHaveLength(1);
    const migration = await readFile(`${import.meta.dir}/../../${migrationPaths[0]}`, 'utf8');
    const backfill = migration.match(/-- Backfill start\n([\s\S]*?)-- Backfill end/)?.[1];
    expect(backfill).toBeDefined();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM community.member_locator WHERE route=$1 AND account_id=$2', [
        routeOf(member.accountId),
        member.accountId,
      ]);
      await client.query(backfill!);
      const rows = await client.query(
        'SELECT realm_id::text FROM community.member_locator WHERE route=$1 AND account_id=$2 ORDER BY realm_id',
        [routeOf(member.accountId), member.accountId],
      );
      expect(rows.rows.map((row) => row.realm_id)).toEqual([...realms].sort());
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  },
);

test.serial(
  "account erasure closes the account's current memberships and erases its membership history in every Realm",
  async () => {
    const { eraseAccountMembershipsPage } = await import('../../src/community/account-erasure-memberships.ts');
    const { system } = communityFixtureRuntime();
    const pool = system.database.pool;
    const access = system.access;
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT * FROM (
    SELECT 'member' AS kind, to_jsonb(m) AS row FROM community.realm_member m WHERE account_id=$1
    UNION ALL SELECT 'terminal', to_jsonb(t) FROM community.realm_member_terminal t WHERE account_id=$1
    ) AS membership_rows ORDER BY kind, row::text`,
          [fixture.outsider.id],
        )
      ).rows;
    const before = await snapshot();
    const bans = (await pool.query('SELECT * FROM community.realm_ban WHERE account_id=$1', [member.accountId])).rows;
    expect(
      (
        await pool.query('SELECT realm_id FROM community.realm_member WHERE account_id=$1 AND upper_inf(valid)', [
          member.accountId,
        ])
      ).rows,
    ).toHaveLength(2);
    expect(
      (await pool.query('SELECT * FROM community.realm_member_terminal WHERE account_id=$1', [member.accountId])).rows,
    ).toHaveLength(2);
    await expect(eraseAccountMembershipsPage({ pool, access }, fixture.outsider.id, null)).rejects.toThrow();
    await deletePersona({ version: 1, pool, auth: deletion.auth }, member);
    await drainEffects(pool, partitionOf(routeOf(member.accountId)!));
    let after: string | null = null;
    let found = 0;
    for (let step = 0; step < 20; step++) {
      const page = await eraseAccountMembershipsPage({ pool, access }, member.accountId, after);
      found += page.found;
      if (page.next === null && page.pending === 0) break;
      after = page.next;
    }
    expect(found).toBe(4);
    expect(
      (await pool.query('SELECT * FROM community.realm_member WHERE account_id=$1', [member.accountId])).rows,
    ).toEqual([]);
    expect(
      (await pool.query('SELECT * FROM community.realm_member_terminal WHERE account_id=$1', [member.accountId])).rows,
    ).toEqual([]);
    expect(await locator()).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(
      (await pool.query('SELECT * FROM community.realm_ban WHERE account_id=$1', [member.accountId])).rows,
    ).toEqual(bans);
    expect(await eraseAccountMembershipsPage({ pool, access }, member.accountId, null)).toEqual({
      next: null,
      found: 0,
      pending: 0,
    });
    // A valid old bearer cannot restore membership after erasure.
    await expect(publish(realms[0]!, member.accountId, null)).rejects.toThrow();
  },
);

test.serial(
  'an account membership erasure page stays within its bound as other Realms and members grow',
  async () => {
    const { eraseAccountMembershipsPage } = await import('../../src/community/account-erasure-memberships.ts');
    const { system } = communityFixtureRuntime();
    const pool = system.database.pool;
    const access = system.access;
    await driver.settle();
    await worker.stop();
    growth = await openGrowthDatabase(pool.options.connectionString!);
    growth.pool.options.max = 1;
    const route = routeOf(member.accountId)!;
    const own = Array.from({ length: 51 }, () => ({ realmId: newId(0x2140), reservationId: newId(route) }));
    const restore = async () => {
      // Consumable fixture state is restored through the uninstrumented administrative pool.
      for (const row of own) {
        await growth.admin.query(`INSERT INTO community.member_locator VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
          route,
          member.accountId,
          0x2140,
          row.realmId,
        ]);
        await growth.admin.query(
          `INSERT INTO community.realm_member (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
        VALUES ($1,$2,$3,'member','[2020-01-01,)', $4,$5) ON CONFLICT DO NOTHING`,
          [0x2140, row.realmId, member.accountId, row.reservationId, newId(0x2140)],
        );
      }
      await growth.admin.query('DELETE FROM community.member_locator_pending WHERE account_id=$1', [member.accountId]);
    };
    const report = await checkGrowth(growth, {
      name: 'an account membership erasure page stays within its bound as other Realms and members grow',
      rule: 'series',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        await seed(
          database,
          {
            name: 'erasure-unrelated-members',
            hotPartition: partitionOf(route),
            hotShare: 0.5,
            rows: ({ route: otherRoute }) => {
              const accountId = newId(otherRoute);
              const realmId = newId(otherRoute);
              return {
                'community.member_locator': [
                  { route: otherRoute, account_id: accountId, realm_route: otherRoute, realm_id: realmId },
                ],
                'community.realm_member': [
                  {
                    route: otherRoute,
                    realm_id: realmId,
                    account_id: accountId,
                    role: 'member',
                    valid: '[2020-01-01,)',
                    reservation_id: newId(otherRoute),
                    transaction_id: newId(otherRoute),
                  },
                ],
                'community.realm_member_terminal': [
                  {
                    route: otherRoute,
                    realm_id: realmId,
                    account_id: accountId,
                    reservation_id: newId(otherRoute),
                    transaction_id: newId(otherRoute),
                    at: '2020-01-01',
                  },
                ],
              };
            },
          },
          { from: previous, to: scale },
        );
      },
      async operation() {
        await restore();
        const page = await eraseAccountMembershipsPage({ pool: growth.pool, access }, member.accountId, null);
        expect(page).toEqual({ next: expect.any(String), found: 50, pending: 0 });
        return page;
      },
    });
    expect(report.samples).toHaveLength(3);
  },
  1_200_000,
);
