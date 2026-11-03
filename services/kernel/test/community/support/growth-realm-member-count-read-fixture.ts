import type { Account, CommunityDriver, CommunityGrowth, Fixture } from '../../../../../specs/community-driver.ts';
import { maintainRealmMemberCounts } from '../../../src/community/member-count.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { closeCommunityDrivers, createCommunityDriver } from '../community-driver.ts';
import type { GrowthDatabase } from '../../support/growth.ts';

export type RealmMemberSummary =
  | Readonly<{ state: 'current'; count: number; version: string }>
  | Readonly<{ state: 'unknown'; count: null; version: null }>;

export type RealmHome = Readonly<{ realmId: string; members: RealmMemberSummary }>;

export type RealmMemberCountReadFixture = Readonly<{
  driver: CommunityDriver;
  accounts: Fixture;
  growth: CommunityGrowth;
  database: GrowthDatabase;
  createRealm(title: string, visibility?: 'public' | 'protected'): Promise<string>;
  readHome(realmId: string, actor?: Account): Promise<RealmHome>;
  growSelectedMembers(scale: number, previous: number): Promise<void>;
  close(): Promise<void>;
}>;

async function responseJson<T>(response: Response, expectedStatus: number, action: string): Promise<T> {
  const text = await response.text();
  if (response.status !== expectedStatus) throw new Error(`${action}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

export async function openRealmMemberCountReadFixture(): Promise<RealmMemberCountReadFixture> {
  let driver: CommunityDriver | undefined;
  try {
    driver = await createCommunityDriver();
    const accounts = await driver.provision();
    const growth = await driver.growthFixture();
    growth.database.pool.options.max = 1;
    const routeValue = routeOf(growth.realmId);
    if (routeValue === null) throw new Error('Growth Realm is not a native routed id');
    const route: number = routeValue;
    const partition = partitionOf(route);

    async function createRealm(title: string, visibility: 'public' | 'protected' = 'public'): Promise<string> {
      const space = await responseJson<{ space: { spaceId: string } }>(
        await driver!.request({
          method: 'POST',
          path: '/v1/spaces',
          actor: accounts.owner,
          key: JSON.stringify(crypto.randomUUID()),
          body: { title },
        }),
        201,
        'Create Realm home Space',
      );
      const realm = await responseJson<{ realm: { realmId: string } }>(
        await driver!.request({
          method: 'POST',
          path: '/v1/realms',
          actor: accounts.owner,
          key: JSON.stringify(crypto.randomUUID()),
          body: { spaceId: space.space.spaceId, title, visibility, contextId: accounts.contextId },
        }),
        201,
        'Create Realm home',
      );
      return realm.realm.realmId;
    }

    async function readHome(realmId: string, actor: Account = growth.actor): Promise<RealmHome> {
      const body = await responseJson<{ community: RealmHome }>(
        await driver!.request({ method: 'GET', path: `/v1/realms/${realmId}/presentation`, actor }),
        200,
        'Read Realm home presentation',
      );
      return body.community;
    }

    async function growSelectedMembers(scale: number, previous: number): Promise<void> {
      if (!Number.isSafeInteger(scale) || scale < 1 || scale < previous)
        throw new RangeError('Selected membership scale must be a positive increasing safe integer');
      const expectedBefore = previous === 0 ? 1 : previous;
      const existing = await growth.database.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM community.realm_member
         WHERE route=$1 AND realm_id=$2 AND role='member' AND upper_inf(valid)`,
        [route, growth.realmId],
      );
      if (Number(existing.rows[0]?.count) !== expectedBefore)
        throw new Error(`Expected ${expectedBefore} selected current memberships before scale ${scale}`);

      const connection = await growth.database.admin.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("SET LOCAL session_replication_role='replica'");
        for (let index = expectedBefore; index < scale; index++) {
          const accountId = newId(route);
          await connection.query(
            `INSERT INTO community.realm_member
               (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
             VALUES($1,$2,$3,'member',tstzrange($4::timestamptz,NULL,'[)'),$5,$6)`,
            [
              route,
              growth.realmId,
              accountId,
              '2020-01-01T00:00:00.000Z',
              newId(routeOf(accountId)!),
              newId(route),
            ],
          );
        }
        await connection.query(
          'UPDATE community.realm_member SET member_count_key=NULL WHERE route=$1 AND realm_id=$2 AND upper_inf(valid)',
          [route, growth.realmId],
        );
        await connection.query('DELETE FROM community.realm_member_count WHERE route=$1 AND realm_id=$2', [
          route,
          growth.realmId,
        ]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }

      await growth.database.admin.query(
        `INSERT INTO community.realm_member_count_install
           (partition_no,cursor_route,cursor_id,frontier_route,frontier_id,complete)
         VALUES($1,$2,'00000000-0000-0000-0000-000000000000',$2,$3,false)
         ON CONFLICT(partition_no) DO UPDATE SET cursor_route=EXCLUDED.cursor_route,cursor_id=EXCLUDED.cursor_id,
           frontier_route=EXCLUDED.frontier_route,frontier_id=EXCLUDED.frontier_id,complete=false`,
        [partition, route, growth.realmId],
      );
      for (let segment = 0; segment < 256; segment++) {
        if (!(await maintainRealmMemberCounts(growth.database.pool, partition))) {
          const counted = await growth.database.admin.query<{ count: string }>(
            'SELECT count::text AS count FROM community.realm_member_count WHERE route=$1 AND realm_id=$2',
            [route, growth.realmId],
          );
          if (counted.rows[0]?.count !== String(scale))
            throw new Error(`Native member-count maintenance did not seed ${scale} members`);
          return;
        }
      }
      throw new Error('Native member-count maintenance exceeded 256 bounded segments');
    }

    let closed = false;
    return {
      driver,
      accounts,
      growth,
      database: growth.database,
      createRealm,
      readHome,
      growSelectedMembers,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await driver!.close();
        } finally {
          await closeCommunityDrivers();
        }
      },
    };
  } catch (error) {
    try {
      await driver?.close();
    } finally {
      await closeCommunityDrivers();
    }
    throw error;
  }
}
