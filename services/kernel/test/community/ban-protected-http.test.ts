import { afterAll, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { Pool } from 'pg';
import type {
  Account,
  CommunityDriver,
  Fixture,
  Method,
  Realm,
  Space,
  Thread,
} from '../../../../specs/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;
beforeEach(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);
afterAll(closeCommunityDrivers);

async function call(
  method: Method,
  path: string,
  actor: Account | null = fixture.owner,
  body?: unknown,
  ifMatch?: string,
) {
  return driver.request({
    method,
    path,
    actor,
    ...(body === undefined ? {} : { body }),
    ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
  });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
async function community(visibility: 'public' | 'protected') {
  const { space } = await json<{ space: Space }>(
    await call('POST', '/v1/spaces', fixture.owner, { title: 'Ban host' }),
    201,
  );
  let { realm } = await json<{ realm: Realm }>(
    await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId,
      title: 'Ban Realm',
      visibility,
      contextId: fixture.contextId,
    }),
    201,
  );
  const { subject: scheme } = await json<{ subject: { id: string } }>(
    await call('POST', '/v1/subjects', fixture.owner, {
      type: 'skos:ConceptScheme',
      labels: { en: 'Ban scheme' },
    }),
    201,
  );
  ({ realm } = await json<{ realm: Realm }>(
    await call(
      'PUT',
      `/v1/realms/${realm.realmId}/boardScheme`,
      fixture.owner,
      { schemeId: scheme.id },
      JSON.stringify(realm.headRevisionId),
    ),
  ));
  const { subject: concept } = await json<{ subject: { id: string } }>(
    await call('POST', '/v1/subjects', fixture.owner, {
      type: 'skos:Concept',
      labels: { en: 'Ban concept' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    }),
    201,
  );
  const { board } = await json<{ board: { id: string } }>(
    await call('POST', `/v1/realms/${realm.realmId}/boards`, fixture.owner, {
      conceptId: concept.id,
      title: 'Ban board',
      visibility: 'published',
    }),
    201,
  );
  const { thread } = await json<{ thread: Thread }>(
    await call('POST', '/v1/threads', fixture.owner, {
      boardId: board.id,
      title: 'Ban thread',
      body: fromPlainText('Protected contribution'),
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
    }),
    201,
  );
  await json(
    await call('POST', `/v1/realms/${realm.realmId}/publications`, fixture.owner, { subjectId: fixture.subject.id }),
    201,
  );
  await driver.settle();
  return { space, realm, board, thread };
}
const realmPath = (realm: Realm) => `/v1/realms/${realm.realmId}`;
const ban = (realm: Realm, target: Account, actor = fixture.owner) =>
  call('PUT', `${realmPath(realm)}/bans/${target.id}`, actor, { reason: 'Repeated abuse' });
async function add(realm: Realm, target: Account) {
  return call('POST', `${realmPath(realm)}/members`, fixture.owner, { accountId: target.id });
}
async function footprint() {
  return queryCommunityDatabase(`SELECT
    (SELECT count(*)::int FROM community.realm_membership_operation) AS operations,
    (SELECT count(*)::int FROM community.realm_member) AS memberships,
    (SELECT count(*)::int FROM community.realm_member_terminal) AS terminals,
    (SELECT count(*)::int FROM access.membership_inverse) AS inverses,
    (SELECT count(*)::int FROM access.resource_grant) AS grants,
    (SELECT count(*)::int FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::int FROM access.resource_denial) AS denials,
    (SELECT count(*)::int FROM community.realm_ban) AS bans,
    (SELECT count(*)::int FROM library.follow) AS follows,
    (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM core.outbox WHERE type LIKE 'com.rezics.community.%') AS events`);
}
function reads(c: Awaited<ReturnType<typeof community>>) {
  const unknown = newId(routeOf(c.realm.realmId)!);
  const pairs = [
    [realmPath(c.realm), `/v1/realms/${unknown}`],
    [`${realmPath(c.realm)}/boards`, `/v1/realms/${unknown}/boards`],
    [`/v1/boards/${c.board.id}`, `/v1/boards/${unknown}`],
    [`/v1/threads/${c.thread.id}`, `/v1/threads/${unknown}`],
    [`/v1/posts/${c.thread.firstPost.id}`, `/v1/posts/${unknown}`],
    [`${realmPath(c.realm)}/publications`, `/v1/realms/${unknown}/publications`],
    [
      `${realmPath(c.realm)}/publications/${fixture.subject.id}`,
      `/v1/realms/${unknown}/publications/${fixture.subject.id}`,
    ],
  ];
  for (const sort of ['new', 'active', 'hot'])
    pairs.push([`/v1/boards/${c.board.id}/threads?sort=${sort}`, `/v1/boards/${unknown}/threads?sort=${sort}`]);
  return pairs as [string, string][];
}
async function hidden(c: Awaited<ReturnType<typeof community>>) {
  for (const [path, unknown] of reads(c)) {
    const denied = await call('GET', path, fixture.member);
    const missing = await call('GET', unknown, fixture.member);
    expect(denied.status).toBe(404);
    expect(denied.status).toBe(missing.status);
    const { request_id: deniedRequest, ...deniedBody } = await denied.json();
    const { request_id: missingRequest, ...missingBody } = await missing.json();
    expect(deniedRequest).toEqual(expect.any(String));
    expect(missingRequest).toEqual(expect.any(String));
    expect(deniedBody).toEqual(missingBody);
  }
  const { space } = await json<{ space: { realmId: string | null } }>(
    await call('GET', `/v1/spaces/${c.space.spaceId}`, fixture.member),
  );
  expect(space.realmId).toBeNull();
}

test.serial(
  "from the ban's T a banned account reads nothing of a protected Realm while its membership removal is still pending",
  async () => {
    const c = await community('protected');
    await json(await add(c.realm, fixture.member), 202);
    await driver.settle();
    // Retain a separate direct read grant after membership removal, too.
    await json(
      await call('POST', '/v1/grants', fixture.owner, {
        resource: { route: routeOf(c.realm.realmId), id: c.realm.realmId },
        subject: { kind: 'account', id: fixture.member.id },
        actions: ['realm:read'],
        valid: '(,)',
      }),
      201,
    );
    for (const [path] of reads(c)) expect((await call('GET', path, fixture.member)).status).toBe(200);
    const [{ database }] = await queryCommunityDatabase<{ database: string }>('SELECT current_database() AS database');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.href });
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      // Hold the native publish update; ordinary MVCC readers still see the open membership.
      await lock.query(
        'SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid) FOR UPDATE',
        [c.realm.realmId, fixture.member.id],
      );
      await json(await ban(c.realm, fixture.member));
      expect(
        await queryCommunityDatabase(
          'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
          [c.realm.realmId, fixture.member.id],
        ),
      ).toEqual([{ role: 'member' }]);
      await hidden(c);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      await pool.end();
      await driver.settle();
    }
    expect(
      await queryCommunityDatabase(
        'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
        [c.realm.realmId, fixture.member.id],
      ),
    ).toEqual([]);
    await hidden(c);
    expect((await call('DELETE', `${realmPath(c.realm)}/bans/${fixture.member.id}`)).status).toBe(204);
    expect((await call('GET', realmPath(c.realm), fixture.member)).status).toBe(200);
  },
  120_000,
);

test.serial(
  'a banned account cannot be added or join until unbanned and the refusal writes nothing',
  async () => {
    const c = await community('public');
    await json(await ban(c.realm, fixture.member));
    await driver.settle();
    const before = await footprint();
    const join = await call('POST', `${realmPath(c.realm)}/membership`, fixture.member);
    const added = await add(c.realm, fixture.member);
    expect(join.status).toBe(403);
    expect(added.status).toBe(403);
    expect(await footprint()).toEqual(before);
    expect((await call('DELETE', `${realmPath(c.realm)}/bans/${fixture.member.id}`)).status).toBe(204);
    await json(await call('POST', `${realmPath(c.realm)}/membership`, fixture.member), 202);
    await driver.settle();
    expect((await call('DELETE', `${realmPath(c.realm)}/membership`, fixture.member)).status).toBe(202);
    await driver.settle();
    await json(await add(c.realm, fixture.member), 202);
    await driver.settle();
    expect((await call('GET', `${realmPath(c.realm)}/members/me`, fixture.member)).status).toBe(200);
  },
  120_000,
);

test.serial(
  "a ban of an account holding the Realm's owner or moderator role is refused",
  async () => {
    const c = await community('protected');
    expect((await driver.grantModerator(c.realm.realmId, fixture.moderator)).status).toBe(201);
    for (const [target, actor] of [
      [fixture.moderator, fixture.owner],
      [fixture.owner, fixture.moderator],
    ]) {
      const before = await footprint();
      const response = await ban(c.realm, target!, actor!);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { detail: string }).detail).toMatch(/remove.*role.*first/i);
      expect(await footprint()).toEqual(before);
      expect((await call('GET', realmPath(c.realm), target!)).status).toBe(200);
    }
  },
  120_000,
);

test.serial(
  'a banned account reads a public Realm as an anonymous reader does',
  async () => {
    const c = await community('public');
    await json(await call('POST', `${realmPath(c.realm)}/membership`, fixture.member), 202);
    await driver.settle();
    await json(await ban(c.realm, fixture.member));
    await driver.settle();
    for (const path of [...reads(c).map(([path]) => path), `/v1/spaces/${c.space.spaceId}`]) {
      const banned = await call('GET', path, fixture.member);
      const anonymous = await call('GET', path, null);
      expect(banned.status).toBe(200);
      expect(banned.status).toBe(anonymous.status);
      expect(await banned.json()).toEqual(await anonymous.json());
    }
  },
  120_000,
);
