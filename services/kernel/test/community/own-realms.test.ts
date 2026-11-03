import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';
import type { Account, CommunityDriver, CommunityGrowth, Fixture } from '../../../../specs/community-driver.ts';
import { partitionOf, newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const growthBounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

let driver: CommunityDriver;
let fixture: Fixture;
let growth: CommunityGrowth | undefined;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);

afterAll(async () => {
  await growth?.close();
  await closeCommunityDrivers();
});

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function key(): string {
  return JSON.stringify(crypto.randomUUID());
}

async function createRealm(actor: Account, title: string): Promise<{ realmId: string; spaceId: string }> {
  const spaceResponse = await driver.request({
    actor,
    method: 'POST',
    path: '/v1/spaces',
    key: key(),
    body: { title: `${title} host` },
  });
  expect(spaceResponse.status).toBe(201);
  const { space } = await body<{ space: { spaceId: string } }>(spaceResponse);
  const realmResponse = await driver.request({
    actor,
    method: 'POST',
    path: '/v1/realms',
    key: key(),
    body: {
      spaceId: space.spaceId,
      title,
      visibility: 'public',
      contextId: fixture.contextId,
    },
  });
  expect(realmResponse.status).toBe(201);
  const { realm } = await body<{ realm: { realmId: string; spaceId: string } }>(realmResponse);
  return realm;
}

async function addStaleInverse(database: GrowthDatabase, actor: Account, realmId: string): Promise<void> {
  const route = routeOf(actor.id);
  if (route === null) throw new Error('Own Realm fixture actor is not routed');
  const reservationId = newId(route);
  const transactionId = newId(route);
  await database.admin.query(
    `INSERT INTO access.membership_inverse
       (route, account_id, kind, group_id, reservation_id, transaction_id, source_transaction_id)
     VALUES ($1, $2, 'realm', $3, $4, $5, $5)
     ON CONFLICT (route, account_id, kind, group_id) DO NOTHING`,
    [route, actor.id, realmId, reservationId, transactionId],
  );
  const current = await database.admin.query(
    `SELECT 1 FROM community.realm_member
      WHERE route = $1 AND realm_id = $2 AND account_id = $3 AND upper_inf(valid)`,
    [routeOf(realmId), realmId, actor.id],
  );
  expect(current.rowCount).toBe(0);
}

function membershipPopulation(actor: Account, contextId: string, suffix: string): Population {
  const accountRoute = routeOf(actor.id);
  if (accountRoute === null) throw new Error('Own Realm fixture actor is not routed');
  const at = '2020-01-01T00:00:00.000Z';
  const interval = '[2020-01-01 00:00:00+00,)';
  return {
    name: `own-realms-${suffix}`,
    hotPartition: partitionOf(accountRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const ownSpaceId = newId(accountRoute);
      const ownSpaceRevisionId = newId(accountRoute);
      const ownRealmId = newId(accountRoute);
      const ownRealmRevisionId = newId(accountRoute);
      const ownReservationId = newId(accountRoute);
      const ownTransactionId = newId(accountRoute);
      const otherAccountId = newId(accountRoute);
      const otherSpaceId = newId(accountRoute);
      const otherSpaceRevisionId = newId(accountRoute);
      const otherRealmId = newId(accountRoute);
      const otherRealmRevisionId = newId(accountRoute);
      const otherReservationId = newId(accountRoute);
      const otherTransactionId = newId(accountRoute);
      const ownName = `Own Realm ${suffix} ${ordinal}`;
      const otherName = `Other Realm ${suffix} ${ordinal}`;
      const spaceRows = (spaceId: string, revisionId: string, name: string) => ({
        space: {
          route: accountRoute,
          space_id: spaceId,
          state: 'active',
          head_revision_id: revisionId,
          created_at: at,
          creator: actor.id,
        },
        revision: {
          route: accountRoute,
          space_id: spaceId,
          revision_id: revisionId,
          predecessor: null,
          title: `${name} host`,
          summary: '',
          created_at: at,
          author: actor.id,
        },
      });
      const ownHost = spaceRows(ownSpaceId, ownSpaceRevisionId, ownName);
      const otherHost = spaceRows(otherSpaceId, otherSpaceRevisionId, otherName);
      const realmRows = (spaceId: string, realmId: string, revisionId: string, name: string) => ({
        realm: {
          route: accountRoute,
          realm_id: realmId,
          space_id: spaceId,
          state: 'active',
          visibility: 'public',
          context_id: contextId,
          head_revision_id: revisionId,
          created_at: at,
          creator: actor.id,
        },
        revision: {
          route: accountRoute,
          realm_id: realmId,
          revision_id: revisionId,
          predecessor: null,
          title: name,
          summary: '',
          visibility: 'public',
          context_id: contextId,
          created_at: at,
          author: actor.id,
        },
      });
      const ownRealm = realmRows(ownSpaceId, ownRealmId, ownRealmRevisionId, ownName);
      const otherRealm = realmRows(otherSpaceId, otherRealmId, otherRealmRevisionId, otherName);
      return {
        'access.account': [
          {
            route: accountRoute,
            account_id: otherAccountId,
            kind: 'actor',
            state: 'active',
            membership_inverse_complete: true,
            transaction_id: otherTransactionId,
          },
        ],
        'community.space': [ownHost.space, otherHost.space],
        'community.space_revision': [ownHost.revision, otherHost.revision],
        'community.realm': [ownRealm.realm, otherRealm.realm],
        'community.realm_revision': [ownRealm.revision, otherRealm.revision],
        'community.realm_member': [
          {
            route: accountRoute,
            realm_id: ownRealmId,
            account_id: actor.id,
            role: 'member',
            valid: interval,
            reservation_id: ownReservationId,
            transaction_id: ownTransactionId,
          },
          {
            route: accountRoute,
            realm_id: otherRealmId,
            account_id: otherAccountId,
            role: 'member',
            valid: interval,
            reservation_id: otherReservationId,
            transaction_id: otherTransactionId,
          },
        ],
        'access.membership_inverse': [
          {
            route: accountRoute,
            account_id: actor.id,
            kind: 'realm',
            group_id: ownRealmId,
            reservation_id: ownReservationId,
            transaction_id: ownTransactionId,
            source_transaction_id: ownTransactionId,
          },
          {
            route: accountRoute,
            account_id: otherAccountId,
            kind: 'realm',
            group_id: otherRealmId,
            reservation_id: otherReservationId,
            transaction_id: otherTransactionId,
            source_transaction_id: otherTransactionId,
          },
        ],
      };
    },
  };
}

test('own Realm pages use confirmed memberships, signed cursors and bounded inverse scans', async () => {
  growth = await driver.growthFixture();
  const actor = growth.actor;

  const current = await driver.request({ actor, method: 'GET', path: '/v1/me/realms' });
  expect(current.status).toBe(200);
  expect(await body(current)).toMatchObject({
    items: [{ realmId: growth.realmId, name: 'Growth probe Realm', role: 'member', current: {
      destination: { kind: 'realm', realmId: growth.realmId },
      viewer: { membership: { state: 'member' } },
      actions: { state: 'unavailable' },
    } }],
    next: null,
  });

  const openapiResponse = await driver.request({ actor: null, method: 'GET', path: '/v1/openapi.json' });
  expect(openapiResponse.status).toBe(200);
  const openapi = await body<{ paths: Record<string, unknown> }>(openapiResponse);
  const contract = JSON.parse(
    await readFile(new URL('../../../../contracts/openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, unknown> };
  expect(openapi.paths['/v1/me/realms']).toEqual(contract.paths['/v1/me/realms']);

  const left = await driver.request({
    actor,
    method: 'DELETE',
    path: `/v1/realms/${growth.realmId}/membership`,
  });
  expect(left.status).toBe(202);
  await driver.settle();
  await addStaleInverse(growth.database, actor, growth.realmId);
  const afterLeave = await driver.request({ actor, method: 'GET', path: '/v1/me/realms' });
  expect(afterLeave.status).toBe(200);
  expect((await body<{ items: { realmId: string }[] }>(afterLeave)).items).toEqual([]);

  const bannedRealm = await createRealm(fixture.owner, 'Own Realms ban probe');
  const joined = await driver.request({
    actor,
    method: 'POST',
    path: `/v1/realms/${bannedRealm.realmId}/membership`,
    key: key(),
  });
  expect(joined.status).toBe(202);
  await driver.settle();
  const ban = await driver.request({
    actor: fixture.owner,
    method: 'PUT',
    path: `/v1/realms/${bannedRealm.realmId}/bans/${actor.id}`,
    key: key(),
    body: { reason: 'Own Realm list ban probe' },
  });
  expect(ban.status).toBe(200);
  await driver.settle();
  await addStaleInverse(growth.database, actor, bannedRealm.realmId);
  const afterBan = await driver.request({ actor, method: 'GET', path: '/v1/me/realms' });
  expect(afterBan.status).toBe(200);
  expect((await body<{ items: { realmId: string }[] }>(afterBan)).items).toEqual([]);

  const pagePopulation = membershipPopulation(actor, fixture.contextId, 'pages');
  await seed(growth.database, pagePopulation, { from: 0, to: 21 });
  const first = await driver.request({ actor, method: 'GET', path: '/v1/me/realms' });
  expect(first.status).toBe(200);
  const firstPage = await body<{ items: { realmId: string; name: string; role: string }[]; next: string | null }>(
    first,
  );
  expect(firstPage.items).toHaveLength(20);
  expect(firstPage.next).toEqual(expect.any(String));
  expect(firstPage.items.every((item) => item.role === 'member' && item.name.startsWith('Own Realm pages '))).toBe(
    true,
  );

  const second = await driver.request({
    actor,
    method: 'GET',
    path: `/v1/me/realms?cursor=${encodeURIComponent(firstPage.next!)}`,
  });
  expect(second.status).toBe(200);
  const secondPage = await body<{ items: { realmId: string }[]; next: string | null }>(second);
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.next).toBeNull();
  expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.realmId)).size).toBe(21);

  const outsider = await driver.request({ actor: fixture.outsider, method: 'GET', path: '/v1/me/realms' });
  expect(outsider.status).toBe(200);
  expect((await body<{ items: unknown[] }>(outsider)).items).toEqual([]);
  const rebound = await driver.request({
    actor: fixture.outsider,
    method: 'GET',
    path: `/v1/me/realms?cursor=${encodeURIComponent(firstPage.next!)}`,
  });
  expect(rebound.status).toBe(400);
  const explicitAccount = await driver.request({
    actor,
    method: 'GET',
    path: `/v1/me/realms?accountId=${encodeURIComponent(fixture.outsider.id)}`,
  });
  expect(explicitAccount.status).toBe(400);

  const growthPopulation = membershipPopulation(actor, fixture.contextId, 'growth');
  const report = await checkGrowth(growth.database, {
    name: 'Own Realm page',
    scales: [20, 160, 1280],
    bounds: growthBounds,
    repetitions: 1,
    async grow(database, scale, previous) {
      await seed(database, growthPopulation, { from: previous, to: scale });
    },
    async operation() {
      const response = await driver.request({ actor, method: 'GET', path: '/v1/me/realms' });
      expect(response.status).toBe(200);
      const page = await body<{ items: unknown[] }>(response);
      expect(page.items).toHaveLength(20);
      return page;
    },
  });
  expect(report.name).toBe('Own Realm page');

  const anonymous = await driver.request({ actor: null, method: 'GET', path: '/v1/me/realms' });
  expect(anonymous.status).toBe(401);
  await growth.close();
  growth = undefined;
  const suspended = await driver.suspend(fixture.outsider);
  expect(suspended.status).toBe(200);
  const refused = await driver.request({ actor: fixture.outsider, method: 'GET', path: '/v1/me/realms' });
  expect(refused.status).toBe(401);
});

test.serial(
  'Space representations expose only the carried Realm the same viewer can read',
  async () => {
    const driver = await createCommunityDriver();
    try {
      const fixture = await driver.provision();
      const request = (
        actor: Account | null,
        method: 'GET' | 'POST' | 'PATCH' | 'PUT',
        path: string,
        body?: unknown,
        ifMatch?: string,
      ) =>
        driver.request({
          actor,
          method,
          path,
          ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
          ...(body === undefined ? {} : { body }),
          ...(ifMatch === undefined ? {} : { ifMatch }),
        });
      const creation = {
        actor: fixture.owner,
        method: 'POST' as const,
        path: '/v1/spaces',
        body: { title: 'Realm host' },
        key: key(),
      };
      const created = await driver.request(creation);
      expect(created.status).toBe(201);
      const initial = (await created.json()) as {
        space: { spaceId: string; headRevisionId: string; realmId: string | null };
      };
      expect(initial.space.realmId).toBeNull();
      const path = `/v1/spaces/${initial.space.spaceId}`;
      expect(
        (await request(fixture.owner, 'POST', '/v1/spaces', { title: 'Invalid carry', realmId: null })).status,
      ).toBe(400);
      expect(
        (await request(fixture.owner, 'PATCH', path, { realmId: null }, JSON.stringify(initial.space.headRevisionId)))
          .status,
      ).toBe(400);
      const viewers = [null, fixture.owner, fixture.member, fixture.outsider];
      const empty = await Promise.all(
        viewers.map(async (actor) => {
          const response = await request(actor, 'GET', path);
          return { status: response.status, headers: [...response.headers], text: await response.text() };
        }),
      );
      const realmResponse = await request(fixture.owner, 'POST', '/v1/realms', {
        spaceId: initial.space.spaceId,
        title: 'Carried Realm',
        visibility: 'protected',
        contextId: fixture.contextId,
      });
      expect(realmResponse.status).toBe(201);
      let { realm } = (await realmResponse.json()) as {
        realm: { realmId: string; headRevisionId: string };
      };
      const realmPath = `/v1/realms/${realm.realmId}`;
      // The same Space before it carries a Realm is the byte-for-byte no-Realm control.
      for (const index of [0, 2, 3]) {
        const response = await request(viewers[index]!, 'GET', path);
        expect({ status: response.status, headers: [...response.headers], text: await response.text() }).toEqual(
          empty[index]!,
        );
        expect((await request(viewers[index]!, 'GET', realmPath)).status).toBe(404);
      }
      const visible = async (actor: Account | null) => {
        const response = await request(actor, 'GET', path);
        expect(response.status).toBe(200);
        expect((await response.json()).space.realmId).toBe(realm.realmId);
        expect(response.headers.get('etag')).toBe(JSON.stringify(initial.space.headRevisionId));
        expect((await request(actor, 'GET', realmPath)).status).toBe(200);
      };
      await visible(fixture.owner);
      const replay = await driver.request(creation);
      expect(replay.status).toBe(201);
      expect((await replay.json()).space.realmId).toBe(realm.realmId);
      expect(replay.headers.get('etag')).toBe(JSON.stringify(initial.space.headRevisionId));
      expect(
        (await request(fixture.owner, 'POST', `${realmPath}/members`, { accountId: fixture.member.id })).status,
      ).toBe(202);
      await driver.settle();
      await visible(fixture.member);
      expect(
        (await request(fixture.owner, 'PUT', `${realmPath}/bans/${fixture.member.id}`, { reason: 'Remove membership' }))
          .status,
      ).toBe(200);
      await driver.settle();
      const banned = await request(fixture.member, 'GET', path);
      expect({ status: banned.status, headers: [...banned.headers], text: await banned.text() }).toEqual(empty[2]!);
      expect((await request(fixture.member, 'GET', realmPath)).status).toBe(404);

      // Removing Realm ownership leaves Space management intact.
      const realmResource = { route: routeOf(realm.realmId)!, id: realm.realmId };
      const [nativeOwner] = await queryCommunityDatabase<{ valid: string }>(
        `SELECT valid::text FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='community.realm.owner'`,
        [realmResource.route, realm.realmId, fixture.owner.id],
      );
      const ownerRole = (account: Account, valid: string) => ({
        resource: realmResource,
        subject: { kind: 'account', id: account.id },
        role: 'community.realm.owner',
        valid,
      });
      expect((await request(fixture.owner, 'POST', '/v1/roleGrants', ownerRole(fixture.moderator, '(,)'))).status).toBe(
        201,
      );
      expect(
        (await request(fixture.owner, 'POST', '/v1/roleGrants:revoke', ownerRole(fixture.owner, nativeOwner!.valid)))
          .status,
      ).toBe(200);
      expect((await request(fixture.owner, 'GET', realmPath)).status).toBe(404);
      const hiddenUpdate = await request(
        fixture.owner,
        'PATCH',
        path,
        { summary: 'Hidden carry' },
        JSON.stringify(initial.space.headRevisionId),
      );
      expect(hiddenUpdate.status).toBe(200);
      const hiddenNext = (await hiddenUpdate.json()).space;
      expect(hiddenNext.realmId).toBeNull();
      const hiddenAddress = await request(
        fixture.owner,
        'PUT',
        `${path}/address`,
        { address: 'hidden-carried-host' },
        JSON.stringify(hiddenNext.headRevisionId),
      );
      expect(hiddenAddress.status).toBe(200);
      const hiddenAddressed = (await hiddenAddress.json()).space;
      expect(hiddenAddressed.realmId).toBeNull();
      expect((await request(fixture.moderator, 'POST', '/v1/roleGrants', ownerRole(fixture.owner, '(,)'))).status).toBe(
        201,
      );
      const updated = await request(
        fixture.owner,
        'PATCH',
        path,
        { summary: 'Changed' },
        JSON.stringify(hiddenAddressed.headRevisionId),
      );
      expect(updated.status).toBe(200);
      const next = (await updated.json()).space;
      expect(next.realmId).toBe(realm.realmId);
      const addressed = await request(
        fixture.owner,
        'PUT',
        `${path}/address`,
        { address: 'carried-realm-host' },
        JSON.stringify(next.headRevisionId),
      );
      expect(addressed.status).toBe(200);
      expect((await addressed.json()).space.realmId).toBe(realm.realmId);
      const publicResponse = await request(
        fixture.owner,
        'PATCH',
        realmPath,
        { visibility: 'public' },
        JSON.stringify(realm.headRevisionId),
      );
      expect(publicResponse.status).toBe(200);
      realm = (await publicResponse.json()).realm;
      for (const actor of viewers) {
        const response = await request(actor, 'GET', path);
        expect((await response.json()).space.realmId).toBe(realm.realmId);
        expect((await request(actor, 'GET', realmPath)).status).toBe(200);
      }
    } finally {
      await driver.close();
    }
  },
  120_000,
);
