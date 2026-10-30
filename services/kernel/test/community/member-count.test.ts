import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import { CommandUnavailableError, mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readRealmMemberCount, maintainRealmMemberCounts } from '../../src/community/member-count.ts';
import open from '../../src/community/membership-open.sql';
import close from '../../src/community/membership-close.sql';
import { createCommunityDriver, closeCommunityDrivers, communityFixtureRuntime } from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;
let pool: Pool;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  pool = communityFixtureRuntime().system.database.pool;
}, 120_000);

afterAll(async () => {
  await driver?.close();
  await closeCommunityDrivers();
});

async function command(
  method: 'POST' | 'DELETE' | 'PUT',
  path: string,
  actor: Account,
  body?: unknown,
  key = crypto.randomUUID(),
) {
  return driver.request({ method, path, actor, key: JSON.stringify(key), ...(body === undefined ? {} : { body }) });
}

async function realm(title: string): Promise<string> {
  const space = await command('POST', '/v1/spaces', fixture.owner, { title });
  expect(space.status).toBe(201);
  const spaceId = ((await space.json()) as { space: { spaceId: string } }).space.spaceId;
  const response = await command('POST', '/v1/realms', fixture.owner, {
    spaceId,
    title,
    visibility: 'public',
    contextId: fixture.contextId,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { realm: { realmId: string } }).realm.realmId;
}

async function read(realmId: string, at?: string) {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const time = await mintReadTime(client, at === undefined ? undefined : () => new Date(at));
    try {
      return await readRealmMemberCount(client, { realmId, at: time });
    } finally {
      releaseOperationalTime(time);
      await client.query('ROLLBACK');
    }
  });
}

async function actual(realmId: string, at: string) {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND role='member' AND valid @> $3::timestamptz`,
    [routeOf(realmId), realmId, at],
  );
  return result.rows[0]!.count;
}

async function insert(realmId: string, accountId = newId(0x1230), at = '2020-01-01T00:00:00Z') {
  const parameters = {
    route: routeOf(realmId)!,
    realm_id: realmId,
    account_id: accountId,
    reservation_id: newId(routeOf(accountId)!),
    transaction_id: newId(routeOf(realmId)!),
    at,
  };
  await open.run(pool, parameters);
  return parameters;
}

test('actual current native Realm memberships produce exact source-version count only after bounded initialization and real removal coverage, with duplicate replay and membership erasure never inventing a decrement', async () => {
  const id = await realm('Native member count');
  // Explicit owner grants and the Space's follows never supply membership rows.
  expect(await read(id)).toEqual({ count: 0, version: '0' });
  expect(await read(newId(routeOf(id)!))).toBeNull();
  const path = `/v1/realms/${id}/membership`;
  const joinKey = crypto.randomUUID();
  expect((await command('POST', path, fixture.member, undefined, joinKey)).status).toBe(202);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 1, version: '1' });
  expect((await command('POST', path, fixture.member, undefined, joinKey)).status).toBe(202);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 1, version: '1' });
  expect((await command('DELETE', path, fixture.member)).status).toBe(202);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 0, version: '2' });
  expect((await command('POST', path, fixture.member)).status).toBe(202);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 1, version: '3' });
  expect((await driver.grantModerator(id, fixture.moderator)).status).toBe(201);
  expect(await read(id)).toEqual({ count: 1, version: '3' });
  const banKey = crypto.randomUUID();
  expect(
    (
      await command(
        'PUT',
        `/v1/realms/${id}/bans/${fixture.member.id}`,
        fixture.moderator,
        { reason: 'Count real native removal' },
        banKey,
      )
    ).status,
  ).toBe(200);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 0, version: '4' });
  expect(
    (
      await command(
        'PUT',
        `/v1/realms/${id}/bans/${fixture.member.id}`,
        fixture.moderator,
        { reason: 'Count real native removal' },
        banKey,
      )
    ).status,
  ).toBe(200);
  await driver.settle();
  expect(await read(id)).toEqual({ count: 0, version: '4' });
  expect(await actual(id, new Date().toISOString())).toBe(0);
}, 120_000);

test('fifty raw current keys per durable seed segment survive live changes, closed history and restart', async () => {
  const id = await realm('Legacy current source seed');
  const route = routeOf(id)!;
  const keys = [];
  for (let i = 0; i < 123; i++) keys.push(await insert(id));
  // Old closed intervals do not consume the current-source page or its EOF.
  for (let i = 0; i < 70; i++) {
    const row = await insert(id);
    await close.run(pool, { ...row, at: '2021-01-01T00:00:00Z', transaction_id: newId(route) });
  }
  // Model an existing pre-install Realm. Only ordinary native upkeep discovers
  // the finite Realm inventory and installs its missing source control.
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      // Pre-migration fixture image only; ordinary writers always install keys.
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query('UPDATE community.realm_member SET member_count_key=NULL WHERE route=$1 AND realm_id=$2', [
        route,
        id,
      ]);
      await client.query('DELETE FROM community.realm_member_count WHERE route=$1 AND realm_id=$2', [route, id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  await pool.query(
    `INSERT INTO community.realm_member_count_install
     (partition_no,cursor_route,cursor_id,frontier_route,frontier_id,complete)
     VALUES($1,$2,'00000000-0000-0000-0000-000000000000',$2,$3,false)
     ON CONFLICT(partition_no) DO UPDATE SET cursor_route=EXCLUDED.cursor_route,cursor_id=EXCLUDED.cursor_id,
       frontier_route=EXCLUDED.frontier_route,frontier_id=EXCLUDED.frontier_id,complete=false`,
    [partitionOf(route), route, id],
  );
  expect(await read(id)).toBeNull();
  await maintainRealmMemberCounts(pool, partitionOf(route)); // install raw Realm keys
  expect(await read(id)).toBeNull();
  await maintainRealmMemberCounts(pool, partitionOf(route)); // install first 50 raw current keys
  const unkeyed = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND upper_inf(valid) AND member_count_key IS NULL`,
    [route, id],
  );
  expect(unkeyed.rows[0]!.count).toBe(73);
  expect(await read(id)).toBeNull();
  await maintainRealmMemberCounts(pool, partitionOf(route)); // install next 50 raw current keys
  await maintainRealmMemberCounts(pool, partitionOf(route)); // remaining 23; capture finite source cut
  expect(await read(id)).toBeNull();
  await maintainRealmMemberCounts(pool, partitionOf(route)); // seed raw source keys 1..50
  const progress = await pool.query<{ count: string; cursor: string; frontier: string }>(
    'SELECT count::text,cursor::text,frontier::text FROM community.realm_member_count WHERE route=$1 AND realm_id=$2',
    [route, id],
  );
  expect(progress.rows[0]!.count).toBe('50');
  expect(BigInt(progress.rows[0]!.cursor)).toBeLessThan(BigInt(progress.rows[0]!.frontier));
  expect(await read(id)).toBeNull();
  // Erase one counted and one unvisited key; close another unvisited key and
  // join beyond the captured cut. None can be counted twice by a stale seed.
  const ordered = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND upper_inf(valid)
     ORDER BY member_count_key`,
    [route, id],
  );
  for (const index of [0, 80])
    await pool.query('DELETE FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=$3', [
      route,
      id,
      ordered.rows[index]!.account_id,
    ]);
  await close.run(pool, {
    ...keys.find((row) => row.account_id === ordered.rows[90]!.account_id)!,
    at: '2021-01-01T00:00:00Z',
    transaction_id: newId(route),
  });
  await insert(id);
  expect(await read(id)).toBeNull();
  const restarted = createPool(pool.options.connectionString!);
  try {
    await maintainRealmMemberCounts(restarted, partitionOf(route)); // next 50 actual keys
    expect(await read(id)).toBeNull();
    await maintainRealmMemberCounts(restarted, partitionOf(route)); // remaining 20
  } finally {
    await restarted.end();
  }
  expect(await read(id)).toEqual({ count: 121, version: '4' });
  expect(await actual(id, new Date().toISOString())).toBe(121);
  expect(await maintainRealmMemberCounts(pool, partitionOf(route))).toBe(false);
}, 120_000);

test('same-T close, source rollback and actual physical erasure change the count once; pending erasure does not', async () => {
  const id = await realm('Removal source coverage');
  const route = routeOf(id)!;
  const row = await insert(id, fixture.member.id);
  expect(await read(id)).toEqual({ count: 1, version: '1' });
  await close.run(pool, { ...row, transaction_id: newId(route) });
  expect(await read(id)).toEqual({ count: 0, version: '2' });
  await close.run(pool, { ...row, transaction_id: newId(route) });
  expect(await read(id)).toEqual({ count: 0, version: '2' });
  const rejoin = await insert(id, fixture.member.id, '2022-01-01T00:00:00Z');
  expect(await read(id)).toEqual({ count: 1, version: '3' });
  // A terminal/inverse removal fact is not a removed native source row.
  await pool.query(
    `INSERT INTO community.realm_member_terminal
    (route,realm_id,account_id,reservation_id,transaction_id,at) VALUES($1,$2,$3,$4,$5,$6)`,
    [route, id, rejoin.account_id, rejoin.reservation_id, newId(route), '2023-01-01T00:00:00Z'],
  );
  expect(await read(id)).toEqual({ count: 1, version: '3' });
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    await client.query('DELETE FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=$3', [
      route,
      id,
      rejoin.account_id,
    ]);
    await client.query('ROLLBACK');
  });
  expect(await read(id)).toEqual({ count: 1, version: '3' });
  const erase = () =>
    pool.query('DELETE FROM community.realm_member WHERE route=$1 AND realm_id=$2 AND account_id=$3', [
      route,
      id,
      rejoin.account_id,
    ]);
  await erase();
  expect(await read(id)).toEqual({ count: 0, version: '4' });
  await erase();
  expect(await read(id)).toEqual({ count: 0, version: '4' });
  await pool.query('UPDATE community.realm_member_count SET removal_coverage=false WHERE route=$1 AND realm_id=$2', [
    route,
    id,
  ]);
  expect(await read(id)).toBeNull();
}, 120_000);

test('injected domain T cannot disclose before a real temporal frontier or during unsupported future history', async () => {
  const id = await realm('Temporal count frontier');
  const row = await insert(id, undefined, '2030-01-01T00:00:00Z');
  expect(await read(id, '2029-01-01T00:00:00Z')).toBeNull();
  expect(await read(id, '2030-01-01T00:00:00Z')).toEqual({ count: 1, version: '1' });
  await close.run(pool, { ...row, at: '2031-01-01T00:00:00Z', transaction_id: newId(routeOf(id)!) });
  expect(await read(id, '2030-06-01T00:00:00Z')).toBeNull();
  expect(await read(id, '2031-01-01T00:00:00Z')).toEqual({ count: 0, version: '2' });
  await pool.query(
    `INSERT INTO community.realm_member(route,realm_id,account_id,role,valid,reservation_id,transaction_id)
    VALUES($1,$2,$3,'member',tstzrange('2032-01-01','infinity','[)'),$4,$5)`,
    [routeOf(id), id, newId(0x1230), newId(0x1230), newId(routeOf(id)!)],
  );
  expect(await read(id, '2033-01-01T00:00:00Z')).toBeNull();
  await withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const time = await mintReadTime(client);
    try {
      await client.query("UPDATE core.partition SET write_state='moved',moved_to='other-home' WHERE partition_no=$1", [
        partitionOf(routeOf(id)!),
      ]);
      const unavailable = readRealmMemberCount(client, { realmId: id, at: time });
      await expect(unavailable).rejects.toBeInstanceOf(CommandUnavailableError);
      await expect(unavailable).rejects.toMatchObject({ reason: 'moved', movedTo: 'other-home' });
      expect(() => readRealmMemberCount(client, { realmId: `${id.slice(0, 14)}4${id.slice(15)}`, at: time })).toThrow(
        TypeError,
      );
    } finally {
      releaseOperationalTime(time);
      await client.query('ROLLBACK');
    }
  });
}, 120_000);
