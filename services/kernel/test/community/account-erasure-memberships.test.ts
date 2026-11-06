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
  membership = createRealmMembership({
    clock: () => new Date(),
      eraseAccountMembershipsPage({ pool, access, deadlineNow: () => Date.now() }, fixture.outsider.id, null),
    ).rejects.toThrow();
    await deletePersona({ version: 1, pool, auth: deletion.auth }, member);
    await drainEffects(pool, partitionOf(routeOf(member.accountId)!));
    let after: string | null = null;
    let found = 0;
    for (let step = 0; step < 20; step++) {
      const page = await eraseAccountMembershipsPage(
        { clock: () => new Date(), pool, access, deadlineNow: () => Date.now()  },        member.accountId,
        after,
      );
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
    expect(
      await eraseAccountMembershipsPage({ pool, access, deadlineNow: () => Date.now() }, member.accountId, null),
    ).toEqual({
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
        const page = await eraseAccountMembershipsPage(
          { clock: () => new Date(), pool: growth.pool, access, deadlineNow: () => Date.now()  },          member.accountId,
          null,
        );
        expect(page).toEqual({ next: expect.any(String), found: 50, pending: 0 });
        return page;
      },
    });
    expect(report.samples).toHaveLength(3);
  },
  1_200_000,
);
