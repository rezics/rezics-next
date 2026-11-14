import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';
import type { CommunityDriver } from '../../../../specs/community-driver.ts';

setDefaultTimeout(180_000);

let driver: CommunityDriver;
let fixture: Awaited<ReturnType<CommunityDriver['provision']>>;

const key = (value: string) => JSON.stringify(value);
const authorityQuery = `
  SELECT home_no AS "homeNo", epoch::text AS epoch
    FROM core.publication_authority_epoch
   WHERE home_no = ANY($1::integer[])
   ORDER BY array_position($1::integer[], home_no)`;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  driver = await createCommunityDriver();
  fixture = await driver.provision();
});

afterAll(async () => {
  await driver?.close();
  await closeCommunityDrivers();
});

test('Realm join and leave update only their publication-authority home and rollbacks retain the prior basis', async () => {
  const suffix = crypto.randomUUID();
  const spaceResponse = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/spaces',
    key: key(`${suffix}-space`),
    body: { title: 'Membership authority Space' },
  });
  expect(spaceResponse.status).toBe(201);
  const spaceId = ((await spaceResponse.json()) as { space: { spaceId: string } }).space.spaceId;
  const realmResponse = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/realms',
    key: key(`${suffix}-realm`),
    body: { spaceId, title: 'Membership authority Realm', visibility: 'protected', contextId: fixture.contextId },
  });
  expect(realmResponse.status).toBe(201);
  const realmId = ((await realmResponse.json()) as { realm: { realmId: string } }).realm.realmId;
  const placements = await queryCommunityDatabase<{ route: number }>(
    'SELECT route FROM community.realm WHERE realm_id = $1',
    [realmId],
  );
  expect(placements).toHaveLength(1);
  const route = placements[0]!.route;
  const homeNo = Math.floor(route / 16);
  const unrelatedHomeNo = (homeNo + 1) % 4096;
  const beforeJoin = await queryCommunityDatabase<{ homeNo: number; epoch: string }>(authorityQuery, [
    [homeNo, unrelatedHomeNo],
  ]);
  expect(beforeJoin.map((row) => row.homeNo)).toEqual([homeNo, unrelatedHomeNo]);

  const join = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: `/v1/realms/${realmId}/members`,
    key: key(`${suffix}-join`),
    body: { accountId: fixture.member.id },
  });
  expect(join.status).toBe(202);
  await driver.settle();
  const afterJoin = await queryCommunityDatabase<{ homeNo: number; epoch: string }>(authorityQuery, [
    [homeNo, unrelatedHomeNo],
  ]);
  expect(afterJoin[0]!.epoch).not.toBe(beforeJoin[0]!.epoch);
  expect(afterJoin[1]!.epoch).toBe(beforeJoin[1]!.epoch);

  await queryCommunityDatabase(
    `DO $publication_authority_rollback$
     DECLARE before_epoch bigint; during_epoch bigint;
     BEGIN
       SELECT epoch INTO before_epoch FROM core.publication_authority_epoch WHERE home_no = ${homeNo};
       DELETE FROM community.realm_member
        WHERE route = ${route} AND realm_id = '${realmId}'::uuid AND account_id = '${fixture.member.id}'::uuid
          AND upper_inf(valid);
       SELECT epoch INTO during_epoch FROM core.publication_authority_epoch WHERE home_no = ${homeNo};
       IF during_epoch <> before_epoch + 1 THEN
         RAISE EXCEPTION 'Realm membership deletion did not invalidate its home';
       END IF;
       RAISE EXCEPTION 'rollback membership deletion' USING ERRCODE = 'Z0001';
     EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
     END;
     $publication_authority_rollback$;`,
  );
  const afterRollback = await queryCommunityDatabase<{ homeNo: number; epoch: string }>(authorityQuery, [
    [homeNo, unrelatedHomeNo],
  ]);
  expect(afterRollback).toEqual(afterJoin);

  const leave = await driver.request({
    actor: fixture.member,
    method: 'DELETE',
    path: `/v1/realms/${realmId}/membership`,
    key: key(`${suffix}-leave`),
  });
  expect(leave.status).toBe(202);
  await driver.settle();
  const afterLeave = await queryCommunityDatabase<{ homeNo: number; epoch: string }>(authorityQuery, [
    [homeNo, unrelatedHomeNo],
  ]);
  expect(afterLeave[0]!.epoch).not.toBe(afterRollback[0]!.epoch);
  expect(afterLeave[1]!.epoch).toBe(afterRollback[1]!.epoch);
});
