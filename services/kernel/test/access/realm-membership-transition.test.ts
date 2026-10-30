import { afterAll, expect, test } from 'bun:test';
import type { Realm } from '../../../../specs/community-driver.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
} from '../community/community-driver.ts';

afterAll(closeCommunityDrivers);

async function body<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

/** One real Auth/Access/Community world; all membership changes use its public commands. */
async function member() {
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  const { system } = communityFixtureRuntime();
  const deletion = accountDeletionRuntime(system);
  const persona = await deletion.person();
  const actor = { id: persona.accountId, bearer: persona.bearer };
  const { space } = await body<{ space: { spaceId: string } }>(
    await driver.request({
      actor: fixture.owner,
      method: 'POST',
      path: '/v1/spaces',
      key: JSON.stringify(crypto.randomUUID()),
      body: { title: 'Membership deletion host' },
    }),
    201,
  );
  const { realm } = await body<{ realm: Realm }>(
    await driver.request({
      actor: fixture.owner,
      method: 'POST',
      path: '/v1/realms',
      key: JSON.stringify(crypto.randomUUID()),
      body: {
        spaceId: space.spaceId,
        title: 'Membership deletion Realm',
        visibility: 'public',
        contextId: fixture.contextId,
      },
    }),
    201,
  );
  const joined = await body<{ workflowId: string }>(
    await driver.request({
      actor,
      method: 'POST',
      path: `/v1/realms/${realm.realmId}/membership`,
      key: JSON.stringify(crypto.randomUUID()),
    }),
    202,
  );
  expect(joined.workflowId).toBeString();
  await driver.settle();
  const inverse = async () =>
    (
      await system.database.pool.query<{ reservationId: string }>(
        `SELECT reservation_id::text AS "reservationId" FROM access.membership_inverse
         WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
        [routeOf(persona.accountId), persona.accountId, realm.realmId],
      )
    ).rows;
  const intervals = async () =>
    (
      await system.database.pool.query<{ reservationId: string; open: boolean }>(
        `SELECT reservation_id::text AS "reservationId", upper_inf(valid) AS open
         FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=$3
         ORDER BY valid`,
        [routeOf(realm.realmId), realm.realmId, persona.accountId],
      )
    ).rows;
  const before = await inverse();
  expect(before).toHaveLength(1);
  expect(await intervals()).toEqual([{ reservationId: before[0]!.reservationId, open: true }]);
  expect(await readErasureStatus(system.database.pool, persona.accountId)).toBeNull();
  return { driver, fixture, system, deletion, persona, actor, realm, inverse, intervals, before };
}

test.serial(
  'a current native Realm member deletes through fresh Auth approval while its inverse and membership await real cleanup',
  async () => {
    const state = await member();
    const { system, persona, realm } = state;
    // The call must reach the genuine lifecycle fence, obligation and outbox transaction.
    // In particular, this fixture never leaves the Realm to make deletion possible.
    const erased = await deletePersona({ pool: system.database.pool, auth: state.deletion.auth }, persona);
    const status = await readErasureStatus(system.database.pool, persona.accountId);
    expect(status).toMatchObject({ state: 'pending', at: erased.at, completedAt: null });
    for (const participant of ['access', 'community', 'shared-history'])
      expect(status?.participants[participant]?.outcome).toBe('pending');
    const terminal = await system.database.pool.query(
      `SELECT state, authn_fenced FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(persona.accountId), persona.accountId],
    );
    expect(terminal.rows).toEqual([{ state: 'deleted', authn_fenced: true }]);
    expect(await state.inverse()).toEqual(state.before);
    expect(await state.intervals()).toEqual([{ reservationId: state.before[0]!.reservationId, open: true }]);
    const event = await system.database.pool.query(
      `SELECT 1 FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3`,
      [partitionOf(routeOf(persona.accountId)!), 'com.rezics.access.account-tombstoned.v1', persona.accountId],
    );
    expect(event.rows).toHaveLength(1);
    const holds = await system.database.pool.query(
      `SELECT reservation_id FROM access.lifecycle_coordination
       WHERE route=$1 AND account_id=$2 AND purpose='membership' AND related_account_id=$3`,
      [routeOf(persona.accountId), persona.accountId, realm.realmId],
    );
    expect(holds.rows).toEqual([]);
  },
  120000,
);

test.serial.each(['leave', 'ban'] as const)(
  'native %s ends membership before terminal inverse release and does not prevent later real account deletion',
  async (ending) => {
    const state = await member();
    if (ending === 'leave') {
      await body(
        await state.driver.request({
          actor: state.actor,
          method: 'DELETE',
          path: `/v1/realms/${state.realm.realmId}/membership`,
          key: JSON.stringify(crypto.randomUUID()),
        }),
        202,
      );
    } else {
      await body(
        await state.driver.request({
          actor: state.fixture.owner,
          method: 'PUT',
          path: `/v1/realms/${state.realm.realmId}/bans/${state.persona.accountId}`,
          key: JSON.stringify(crypto.randomUUID()),
          body: { reason: 'Membership deletion negative control' },
        }),
        200,
      );
    }
    await state.driver.settle();
    expect(await state.inverse()).toEqual([]);
    expect((await state.intervals()).every((interval) => !interval.open)).toBe(true);
    const erased = await deletePersona({ pool: state.system.database.pool, auth: state.deletion.auth }, state.persona);
    expect(await readErasureStatus(state.system.database.pool, state.persona.accountId)).toMatchObject({
      at: erased.at,
      completedAt: null,
    });
  },
  120000,
);
