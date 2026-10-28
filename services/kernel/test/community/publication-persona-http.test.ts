import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Account, CommunityDriver, Fixture, Method, Realm, Space } from '../../../../specs/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  closeCommunityDrivers,
  createCommunityDriver,
  queryCommunityDatabase,
  restartWorker,
  worker,
} from './community-driver.ts';

type Head = {
  realmId: string;
  subjectId: string;
  publicationId: string;
  verdict: 'adopt' | 'withdraw' | 'reject';
  predecessor?: string | null;
  subjectRevisionId: null;
  publishedAt: string;
};
type Persona = { name: string; actor: Account | null; protectedRead: boolean };
let driver: CommunityDriver;
let fixture: Fixture;
let personas: Persona[];
let snapshotSql: string;
let secrets: string[];

beforeEach(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  personas = [
    { name: 'anonymous', actor: null, protectedRead: false },
    { name: 'member', actor: fixture.member, protectedRead: true },
    { name: 'moderator', actor: fixture.moderator, protectedRead: true },
    // Governance owns the subject but has no realm:publish or realm:read grant.
    { name: 'banned account', actor: fixture.subjectOwner, protectedRead: false },
    { name: 'protected outsider', actor: fixture.outsider, protectedRead: false },
  ];
  // The driver's isolated application pool uses the administrative database identity.
  expect(await queryCommunityDatabase('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).toEqual([
    { rolsuper: true },
  ]);
  const tables = await queryCommunityDatabase<{ name: string; quoted: string }>(`SELECT
      n.nspname || '.' || c.relname AS name, format('%I.%I', n.nspname, c.relname) AS quoted
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('community', 'content', 'access', 'library', 'core', 'dbos', 'semantic')
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    ORDER BY n.nspname, c.relname`);
  for (const name of [
    'community.publication',
    'community.publication_head',
    'access.resource_role_grant',
    'access.resource_grant',
    'library.follow',
    'dbos.workflow_status',
    'core.receipt',
    'core.outbox',
    'semantic.subject',
  ])
    expect(tables.map((table) => table.name)).toContain(name);
  // Compare complete rows, including edits to existing rows, in one SQL snapshot.
  snapshotSql =
    tables
      .map(
        (table) => `SELECT '${table.name}' AS name,
        coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
        FROM ${table.quoted} t`,
      )
      .join(' UNION ALL ') + ' ORDER BY name';
  const subject = await call('GET', `/v1/subjects/${fixture.subject.id}`, fixture.subjectOwner);
  expect(subject.status).toBe(200);
  const bytes = await subject.text();
  secrets = [fixture.subject.id, 'Fixture subject', 'A globally owned fixture subject', 'Fixture book'];
  secrets.push(createHash('sha256').update(bytes).digest('hex'));
}, 120_000);
afterAll(closeCommunityDrivers);

function call(method: Method, path: string, actor: Account | null, body?: unknown, head?: string) {
  return driver.request({
    method,
    path,
    actor,
    ...(method === 'GET' ? {} : { key: JSON.stringify(crypto.randomUUID()) }),
    ...(body === undefined ? {} : { body }),
    ...(head === undefined ? {} : { ifMatch: JSON.stringify(head) }),
  });
}
async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
const pathOf = (realm: Realm) => `/v1/realms/${realm.realmId}/publications`;
const snapshot = () => queryCommunityDatabase<{ name: string; rows: unknown[] }>(snapshotSql);

async function identity() {
  return (await snapshot()).filter(
    (table) =>
      table.name.startsWith('semantic.') ||
      ['access.resource_grant', 'access.resource_role_grant', 'access.resource_initialization'].includes(table.name),
  );
}
async function slot(realm: Realm) {
  return queryCommunityDatabase(
    `SELECT to_jsonb(h) AS head, to_jsonb(p) AS record
       FROM community.publication_head h
       JOIN community.publication p ON p.route = h.route AND p.publication_id = h.publication_id
      WHERE h.realm_id = $1 AND h.subject_id = $2`,
    [realm.realmId, fixture.subject.id],
  );
}

async function refusal(request: () => Promise<Response>, status: number, mutation = false) {
  const before = await snapshot();
  const response = await request();
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  for (const header of ['etag', 'content-digest', 'digest', 'location'])
    expect(response.headers.get(header)).toBeNull();
  const bytes = await response.text();
  const problem = JSON.parse(bytes) as Record<string, unknown>;
  expect(problem).toMatchObject({ status, effect_status: mutation ? 'not_applied' : 'not_applicable' });
  // A refusal may carry only the documented problem envelope, never resource bytes or keys.
  const allowed = ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id', 'detail', 'errors'];
  expect(Object.keys(problem).filter((key) => !allowed.includes(key))).toEqual([]);
  expect(bytes).not.toMatch(/"(?:body|object[_A-Z]?key|digest|publication|subject|items)"\s*:/i);
  expect(bytes).not.toContain('sha256:');
  for (const secret of secrets) expect(bytes).not.toContain(secret);
  expect(await snapshot()).toEqual(before);
  const { request_id: requestId, ...stable } = problem;
  expect(requestId).toEqual(expect.any(String));
  return stable;
}

async function realms() {
  const result: Realm[] = [];
  for (const visibility of ['public', 'protected'] as const) {
    const { space } = await json<{ space: Space }>(
      await call('POST', '/v1/spaces', fixture.owner, { title: 'Publication persona host' }),
      201,
    );
    const { realm } = await json<{ realm: Realm }>(
      await call('POST', '/v1/realms', fixture.owner, {
        spaceId: space.spaceId,
        title: 'Publication persona Realm',
        visibility,
        contextId: fixture.contextId,
      }),
      201,
    );
    secrets.push(realm.realmId);
    const resource = { route: routeOf(realm.realmId)!, id: realm.realmId };
    await json(
      await call('POST', '/v1/roleGrants', fixture.owner, {
        resource,
        subject: { kind: 'account', id: fixture.moderator.id },
        role: 'community.realm.moderator',
        valid: '(,)',
      }),
      201,
    );
    for (const actor of [fixture.member, fixture.subjectOwner])
      await json(
        await call('POST', `/v1/realms/${realm.realmId}/members`, fixture.owner, { accountId: actor.id }),
        202,
      );
    // The ban must defeat this independent read grant even before membership removal.
    await json(
      await call('POST', '/v1/grants', fixture.owner, {
        resource,
        subject: { kind: 'account', id: fixture.subjectOwner.id },
        actions: ['realm:read'],
        valid: '(,)',
      }),
      201,
    );
    result.push(realm);
  }
  await driver.settle();
  expect(
    await queryCommunityDatabase('SELECT state FROM access.account WHERE account_id=$1', [fixture.outsider.id]),
  ).toEqual([{ state: 'active' }]);
  for (const realm of result) {
    for (const actor of [fixture.member, fixture.subjectOwner]) {
      const membership = await json(await call('GET', `/v1/realms/${realm.realmId}/members/me`, actor), 200);
      expect(membership).toMatchObject({ state: 'member' });
    }
    expect(
      await queryCommunityDatabase(
        'SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
        [realm.realmId, fixture.outsider.id],
      ),
    ).toEqual([]);
    expect(
      await queryCommunityDatabase(
        `SELECT 1 FROM access.resource_grant WHERE resource_id=$1 AND subject_id=$2
       UNION ALL SELECT 1 FROM access.resource_role_grant WHERE resource_id=$1 AND subject_id=$2`,
        [realm.realmId, fixture.outsider.id],
      ),
    ).toEqual([]);
  }
  return result;
}

async function banWithRemovalPending(realms: Realm[]) {
  for (const realm of realms) {
    await json(
      await call('PUT', `/v1/realms/${realm.realmId}/bans/${fixture.subjectOwner.id}`, fixture.owner, {
        reason: 'Publication persona ban',
      }),
      200,
    );
    expect(
      await queryCommunityDatabase(
        'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
        [realm.realmId, fixture.subjectOwner.id],
      ),
    ).toEqual([{ role: 'member' }]);
    expect(
      await queryCommunityDatabase(
        'SELECT 1 FROM community.realm_ban WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
        [realm.realmId, fixture.subjectOwner.id],
      ),
    ).toEqual([{ '?column?': 1 }]);
  }
}

async function publish(realm: Realm, actor: Account, previous?: Head): Promise<Head> {
  const before = await identity();
  const response = await call('POST', pathOf(realm), actor, { subjectId: fixture.subject.id }, previous?.publicationId);
  const { publication } = await json<{ publication: Head }>(response, 201);
  expect(publication).toMatchObject({
    realmId: realm.realmId,
    subjectId: fixture.subject.id,
    verdict: 'adopt',
    subjectRevisionId: null,
  });
  expect(response.headers.get('etag')).toBe(JSON.stringify(publication.publicationId));
  if (previous) expect(publication.publicationId).not.toBe(previous.publicationId);
  secrets.push(publication.publicationId);
  expect(await slot(realm)).toMatchObject([
    {
      head: { publication_id: publication.publicationId, verdict: 'adopt' },
      record: { predecessor: previous?.publicationId ?? null, verdict: 'adopt' },
    },
  ]);
  expect(await identity()).toEqual(before);
  return publication;
}

async function reads(realm: Realm, head: Head | null) {
  for (const persona of personas) {
    const path = pathOf(realm);
    const readable = realm.visibility === 'public' || persona.protectedRead;
    const unknown = await refusal(
      () => call('GET', `${path}/${newId(routeOf(fixture.subject.id)!)}`, persona.actor),
      404,
    );
    if (readable) {
      const list = await json(await call('GET', path, persona.actor), 200);
      expect(list).toEqual({ items: head === null ? [] : [head], next: null });
    } else {
      expect(await refusal(() => call('GET', path, persona.actor), 404)).toEqual(unknown);
    }
    if (readable && head !== null) {
      const read = await call('GET', `${path}/${fixture.subject.id}`, persona.actor);
      expect(await json(read, 200)).toEqual({ publication: head });
      expect(read.headers.get('etag')).toBe(JSON.stringify(head.publicationId));
    } else {
      expect(await refusal(() => call('GET', `${path}/${fixture.subject.id}`, persona.actor), 404)).toEqual(unknown);
    }
  }
}

test.serial(
  'publication reads and lifecycle answer each of the five personas with slot and head unchanged on every refusal',
  async () => {
    const communities = await realms();
    await worker.stop();
    try {
      await banWithRemovalPending(communities);
      const denied = personas.filter((persona) => persona.name !== 'moderator');
      for (const realm of communities) {
        const path = pathOf(realm);
        const identityBefore = await identity();
        for (const persona of denied)
          await refusal(
            () => call('POST', path, persona.actor, { subjectId: fixture.subject.id }),
            persona.actor === null ? 401 : 403,
            true,
          );
        expect(await slot(realm)).toEqual([]);
        let head = await publish(realm, fixture.moderator);
        await reads(realm, head);
        for (const persona of denied)
          await refusal(
            () => call('POST', path, persona.actor, { subjectId: fixture.subject.id }, head.publicationId),
            persona.actor === null ? 401 : 403,
            true,
          );
        head = await publish(realm, fixture.moderator, head);
        head = await publish(realm, fixture.owner, head);
        await reads(realm, head);
        for (const verb of ['withdraw', 'reject'] as const) {
          for (const publisher of [fixture.moderator, fixture.owner]) {
            for (const persona of denied)
              await refusal(
                () =>
                  call('POST', `${path}/${fixture.subject.id}:${verb}`, persona.actor, undefined, head.publicationId),
                persona.actor === null ? 401 : 403,
                true,
              );
            const previous = head;
            const response = await call(
              'POST',
              `${path}/${fixture.subject.id}:${verb}`,
              publisher,
              undefined,
              head.publicationId,
            );
            ({ publication: head } = await json<{ publication: Head }>(response, 200));
            expect(head).toMatchObject({ verdict: verb, predecessor: previous.publicationId, subjectRevisionId: null });
            expect(head.publicationId).not.toBe(previous.publicationId);
            expect(response.headers.get('etag')).toBe(JSON.stringify(head.publicationId));
            secrets.push(head.publicationId);
            await reads(realm, null);
            head = await publish(realm, publisher, head);
          }
        }
        expect(await identity()).toEqual(identityBefore);
      }
    } finally {
      await restartWorker();
      await driver.settle();
    }
  },
  120_000,
);

test.serial(
  'a published subject taken down while its slot stays adopted disappears from lists and reads for every persona',
  async () => {
    const communities = await realms();
    const heads = new Map<Realm, Head>();
    for (const realm of communities) heads.set(realm, await publish(realm, fixture.moderator));
    await driver.settle();
    await worker.stop();
    try {
      await banWithRemovalPending(communities);
      for (const realm of communities) await reads(realm, heads.get(realm)!);
      const slotsBefore = await Promise.all(communities.map(slot));
      await json(
        await call('POST', `/v1/subjects/${fixture.subject.id}:takedown`, fixture.subjectOwner, {
          notice: { complaint: 'Publication subject unavailable', received_at: new Date().toISOString() },
        }),
        200,
      );
      for (const realm of communities) await reads(realm, null);
      expect(await Promise.all(communities.map(slot))).toEqual(slotsBefore);
      for (const rows of slotsBefore) {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ head: { verdict: 'adopt' }, record: { verdict: 'adopt' } });
      }
    } finally {
      await restartWorker();
      await driver.settle();
    }
  },
  120_000,
);
