import { afterAll, beforeAll, expect, test } from 'bun:test';
import type {
  Account,
  CommunityDriver,
  Fixture,
  Method,
  Realm,
  Space,
  Subject,
} from '../../../../specs/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase, worker } from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;
let book: Subject;
let accepted: string;
let authorId: string;
let rejected: string;
let communities: Realm[];
let snapshotSql: string;
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});

async function call(method: Method, path: string, actor: Account | null, body?: unknown) {
  return driver.request({
    method,
    path,
    actor,
    ...(body === undefined ? {} : { body }),
    ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
  });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
const subjectPath = (context: string) => `/v1/subjects/${book.id}?context=${context}`;
const candidatePath = (context: string, property: string) =>
  `/v1/subjects/${book.id}/candidates?context=${context}&property=${property}${property === 'schema:author' ? `&target=${authorId}` : ''}`;
const decide = (context: string, candidate: string, verb: 'accept' | 'reject', actor: Account | null) =>
  call('POST', `/v1/subjects/${book.id}/candidates/${candidate}:${verb}`, actor, { context, expected_head: null });
const snapshot = () => queryCommunityDatabase(snapshotSql);

// These are the driver's independently authenticated accounts, assigned by their actual authority here.
function personas() {
  return [
    { name: 'anonymous', actor: null },
    { name: 'member', actor: fixture.moderator },
    { name: 'moderator', actor: fixture.owner },
    { name: 'banned', actor: fixture.member },
    { name: 'outsider', actor: fixture.outsider },
  ];
}

async function community(visibility: 'public' | 'protected'): Promise<Realm> {
  const { context } = await json<{ context: { id: string } }>(
    await call('POST', '/v1/contexts', fixture.owner, { labels: { en: `${visibility} editorial Context` } }),
    201,
  );
  const { space } = await json<{ space: Space }>(
    await call('POST', '/v1/spaces', fixture.owner, { title: `${visibility} host` }),
    201,
  );
  const { realm } = await json<{ realm: Realm }>(
    await call('POST', '/v1/realms', fixture.owner, {
      spaceId: space.spaceId,
      title: `${visibility} Realm`,
      visibility,
      contextId: context.id,
    }),
    201,
  );
  // Context authority and the Realm role are separate, explicit grants, even for this owner.
  for (const [id, role] of [
    [realm.realmId, 'community.realm.moderator'],
    [context.id, 'semantic.context.moderator'],
  ]) {
    await json(
      await call('POST', '/v1/roleGrants', fixture.owner, {
        resource: { route: routeOf(id!), id },
        subject: { kind: 'account', id: fixture.owner.id },
        role,
        valid: '(,)',
      }),
      201,
    );
  }
  for (const account of [fixture.moderator, fixture.member]) {
    await json(
      await call('POST', `/v1/realms/${realm.realmId}/members`, fixture.owner, { accountId: account.id }),
      202,
    );
  }
  await driver.settle();
  await json(await call('GET', `/v1/realms/${realm.realmId}/members/me`, fixture.moderator));
  await json(await call('GET', `/v1/realms/${realm.realmId}/members/me`, fixture.member));
  // The protected ban must veto an independent Realm read grant as well as membership.
  await json(
    await call('POST', '/v1/grants', fixture.owner, {
      resource: { route: routeOf(realm.realmId), id: realm.realmId },
      subject: { kind: 'account', id: fixture.member.id },
      actions: ['realm:read'],
      valid: '(,)',
    }),
    201,
  );
  await json(
    await call('PUT', `/v1/realms/${realm.realmId}/bans/${fixture.member.id}`, fixture.owner, {
      reason: 'Persona fixture ban',
    }),
  );
  await driver.settle();
  await json(await decide(context.id, accepted, 'accept', fixture.owner));
  await json(await decide(context.id, rejected, 'reject', fixture.owner));
  return realm;
}

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  const { subject: author } = await json<{ subject: Subject }>(
    await call('POST', '/v1/subjects', fixture.subjectOwner, {
      type: 'schema:Person',
      labels: { en: 'Global author' },
    }),
    201,
  );
  const created = await json<{ subject: Subject }>(
    await call('POST', '/v1/subjects', fixture.subjectOwner, {
      type: 'schema:Book',
      labels: { en: 'Global identity survives Realm decisions' },
      descriptions: { en: 'Global description' },
      aliases: { en: ['Global alias'] },
      statements: {
        'schema:author': [statement('schema:author', author.id)],
        'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
        'schema:datePublished': [
          statement('schema:datePublished', {
            time: '+2010-02-23T00:00:00Z',
            precision: 11,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          }),
        ],
      },
    }),
    201,
  );
  authorId = author.id;
  book = created.subject;
  accepted = book.statements['schema:datePublished']![0]!.id;
  rejected = book.statements['schema:author']![0]!.id;
  communities = [await community('public'), await community('protected')];
  await driver.settle();
  // Quiesce only this driver's worker so every before/after snapshot includes stable workflow rows.
  await worker.stop();
  const tables = await queryCommunityDatabase<{
    schema: string;
    name: string;
  }>(`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND
      (n.nspname IN ('community','content','semantic','access','library','dbos') OR
       (n.nspname='core' AND c.relname IN ('receipt','outbox','partition')))
    ORDER BY n.nspname, c.relname`);
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  snapshotSql = tables
    .map(
      ({ schema, name }) =>
        `SELECT '${schema}.${name}' AS relation, COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS rows FROM ${quote(schema)}.${quote(name)} r`,
    )
    .join(' UNION ALL ');
  expect(tables.some(({ schema }) => schema === 'dbos')).toBe(true);
  for (const realm of communities) {
    expect(
      await queryCommunityDatabase(
        'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND valid @> clock_timestamp()',
        [realm.realmId, fixture.moderator.id],
      ),
    ).toEqual([{ role: 'member' }]);
    expect(
      await queryCommunityDatabase(
        'SELECT 1 FROM community.realm_ban WHERE realm_id=$1 AND account_id=$2 AND valid @> clock_timestamp()',
        [realm.realmId, fixture.member.id],
      ),
    ).toHaveLength(1);
    expect(
      await queryCommunityDatabase(
        `SELECT 1 FROM access.resource_role_grant
      WHERE resource_id=$1 AND subject_id=$2 AND grant_role='community.realm.moderator' AND valid @> clock_timestamp()`,
        [realm.realmId, fixture.owner.id],
      ),
    ).toHaveLength(1);
    expect(
      await queryCommunityDatabase(
        `SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2
      UNION ALL SELECT 1 FROM access.resource_grant WHERE resource_id IN ($1,$3) AND subject_id=$2
      UNION ALL SELECT 1 FROM access.resource_role_grant WHERE resource_id IN ($1,$3) AND subject_id=$2`,
        [realm.realmId, fixture.outsider.id, realm.contextId],
      ),
    ).toEqual([]);
    expect(
      await queryCommunityDatabase(
        `SELECT 1 FROM access.resource_grant WHERE resource_id=$1 AND subject_id=$2
      UNION ALL SELECT 1 FROM access.resource_role_grant WHERE resource_id=$1 AND subject_id=$2`,
        [realm.contextId, fixture.moderator.id],
      ),
    ).toEqual([]);
  }
  expect(
    await queryCommunityDatabase(
      'SELECT state FROM access.account WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',
      [personas().flatMap(({ actor }) => (actor ? [actor.id] : []))],
    ),
  ).toEqual(Array.from({ length: 4 }, () => ({ state: 'active' })));
}, 120_000);
afterAll(closeCommunityDrivers);

async function refused(method: Method, path: string, actor: Account | null, status: 401 | 403 | 404, body?: unknown) {
  const before = await snapshot();
  const response = await call(method, path, actor, body);
  const bytes = await response.text();
  expect(response.status).toBe(status);
  const code = { 401: 'authentication_required', 403: 'forbidden', 404: 'not_found' }[status];
  // An exact problem envelope allows no subject/content bytes, object keys, or digests.
  const problem = JSON.parse(bytes) as Record<string, unknown>;
  expect(problem).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title: { 401: 'Authentication Required', 403: 'Forbidden', 404: 'Not Found' }[status],
    status,
    code,
    retryable: false,
    effect_status: method === 'GET' ? 'not_applicable' : 'not_applied',
    request_id: expect.any(String),
  });
  expect(bytes).not.toContain(book.labels.en!);
  expect(bytes).not.toMatch(/sha256:|object_key|storage_key|"digest"|"statements"|"body"/i);
  expect(await snapshot()).toEqual(before);
  const { request_id: _requestId, ...stable } = problem;
  return stable;
}

test('a Realm Context accepts and rejects locally and falls back to Global for every persona', async () => {
  const global = (await json<{ subject: Subject }>(await call('GET', subjectPath(GLOBAL_CONTEXT), fixture.owner)))
    .subject;
  expect(global.statements['schema:datePublished']).toEqual(book.statements['schema:datePublished']);
  expect(global.statements['schema:author']![0]!.id).toBe(rejected);
  for (const realm of communities) {
    for (const { name, actor } of personas()) {
      if (realm.visibility === 'protected' && ['anonymous', 'outsider', 'banned'].includes(name)) {
        const unknown = newId(routeOf(realm.contextId)!);
        for (const path of [subjectPath, (context: string) => candidatePath(context, 'schema:author')]) {
          expect(await refused('GET', path(realm.contextId), actor, 404)).toEqual(
            await refused('GET', path(unknown), actor, 404),
          );
        }
        continue;
      }
      const local = (await json<{ subject: Subject }>(await call('GET', subjectPath(realm.contextId), actor))).subject;
      expect(local.context).toBe(realm.contextId);
      expect(local.statements['schema:datePublished']!.map(({ id }) => id)).toEqual([accepted]);
      expect(local.statements['schema:author'] ?? []).toEqual([]);
      expect(local.statements['schema:inLanguage']).toEqual(global.statements['schema:inLanguage']);
      for (const field of ['id', 'type', 'labels', 'descriptions', 'aliases'] as const)
        expect(local[field]).toEqual(global[field]);
      for (const [property, id, decision, head] of [
        ['schema:datePublished', accepted, 'accepted', 1],
        ['schema:author', rejected, 'rejected', 1],
        ['schema:inLanguage', book.statements['schema:inLanguage']![0]!.id, null, null],
      ] as const) {
        const { candidates } = await json<{ candidates: Record<string, unknown>[] }>(
          await call('GET', candidatePath(realm.contextId, property), actor),
        );
        expect(candidates).toContainEqual(expect.objectContaining({ id, decision, head }));
      }
    }
  }
}, 120_000);

test('no persona can change global identity through a Realm Context', async () => {
  const global = await json(await call('GET', subjectPath(GLOBAL_CONTEXT), fixture.owner));
  for (const realm of communities) {
    for (const { actor } of personas()) {
      // Merge is the documented global identity mutation; a caller-selected Context cannot move its authority.
      await refused('POST', `/v1/subjects:merge?context=${realm.contextId}`, actor, actor ? 403 : 401, {
        subjects: [book.id, fixture.subject.id],
      });
      expect(await json(await call('GET', subjectPath(GLOBAL_CONTEXT), fixture.owner))).toEqual(global);
    }
    for (const verb of ['accept', 'reject'] as const) {
      await refused('POST', `/v1/subjects/${book.id}/candidates/${rejected}:${verb}`, fixture.moderator, 403, {
        context: realm.contextId,
        expected_head: 1,
      });
    }
  }
}, 120_000);
