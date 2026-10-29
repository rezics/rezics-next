import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type DiscoveryAccountName,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}
function denied(response: HttpResponse) {
  status(response, 403);
  expect(response.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(response.body).not.toHaveProperty('realm');
}
async function grants() {
  return (await fixture.inspect('SELECT * FROM access.resource_grant g ORDER BY to_jsonb(g)::text')).rows;
}
async function controls() {
  return {
    accounts: (await fixture.inspect('SELECT * FROM access.account ORDER BY account_id')).rows,
    openings: (await fixture.inspect('SELECT * FROM access.exposure_opening ORDER BY "group"')).rows,
    roles: (await fixture.inspect('SELECT * FROM access.resource_role_grant g ORDER BY to_jsonb(g)::text')).rows,
    spaces: (await fixture.inspect('SELECT * FROM community.space ORDER BY space_id')).rows,
    realms: (await fixture.inspect('SELECT * FROM community.realm ORDER BY realm_id')).rows,
  };
}
function scopes(persona: DiscoveryAccountName) {
  // Read the actual issued claim; authorization below still goes through native Access.
  const payload = JSON.parse(Buffer.from(fixture.personas[persona].bearer.split('.')[1]!, 'base64url').toString());
  return payload.scope === '' ? [] : (payload.scope as string).split(' ');
}
async function space(persona: 'alice' | 'bob', title: string) {
  return status(
    await fixture.request(persona, 'POST', '/v1/spaces', { title, summary: 'Native Realm host' }, discoveryKey()),
    201,
  ).space as { spaceId: string; creator: string };
}

test('explicit named Realm setup grants only native Global realm create and preserves independent native Space and Context checks', async () => {
  const context = status(
    await fixture.request(
      'editor',
      'POST',
      '/v1/contexts',
      { labels: { en: 'Discovery Realm classification' } },
      discoveryKey(),
    ),
    201,
  ).context as { id: string; kind: string };
  expect(context).toMatchObject({ kind: 'community', settings: null, defaults: {} });
  expect(status(await fixture.request('alice', 'GET', `/v1/contexts/${context.id}`), 200).context).toEqual(context);
  await fixture.setup.spaceCreation('alice');
  await fixture.setup.spaceCreation('bob');
  const aliceSpace = await space('alice', 'Alice Realm host');
  const bobSpace = await space('bob', 'Bob independent host');
  expect(aliceSpace.creator).toBe(fixture.personas.alice.accountId);
  const body = {
    spaceId: aliceSpace.spaceId,
    title: 'Discovery native Realm',
    summary: 'Explicit Realm capability control',
    visibility: 'protected',
    contextId: context.id,
  };
  const before = await controls();
  const beforeGrants = await grants();
  const original = structuredClone(fixture.personas);
  const originalScopes = scopes('alice');
  expect(originalScopes).toEqual(
    expect.arrayContaining(['realm:create', 'space:manage', 'context:read', 'realm:read']),
  );
  denied(await fixture.request('alice', 'POST', '/v1/realms', body, discoveryKey()));
  expect(await controls()).toEqual(before);
  for (const invalid of ['invented', 'editor', 'anonymous', 'toString', '__proto__'])
    await expect(fixture.setup.realmCreation(invalid as DiscoveryAccountName)).rejects.toThrow(
      'named discovery account',
    );
  expect(await grants()).toEqual(beforeGrants);
  expect(await controls()).toEqual(before);

  expect(await fixture.setup.realmCreation('alice')).toBeUndefined();
  const afterGrants = await grants();
  const added = afterGrants.filter(
    (row) => !beforeGrants.some((prior) => JSON.stringify(prior) === JSON.stringify(row)),
  );
  expect(added).toHaveLength(1);
  expect(added).toMatchObject([
    {
      route: 0,
      resource_id: '00000000-0000-8000-8000-000000000000',
      subject_id: original.alice.accountId,
      action: 'realm:create',
    },
  ]);
  expect(afterGrants.filter((row) => row !== added[0])).toEqual(beforeGrants);
  expect(await controls()).toEqual(before);
  expect(fixture.personas).toEqual(original);
  expect(scopes('alice')).toEqual(originalScopes);

  // Global creation does not replace the separate Space owner and Context checks.
  for (const spaceId of [bobSpace.spaceId, context.id, newId(routeOf(aliceSpace.spaceId)!)])
    denied(await fixture.request('alice', 'POST', '/v1/realms', { ...body, spaceId }, discoveryKey()));
  const unknownContext = newId(routeOf(context.id)!);
  status(await fixture.request('alice', 'GET', `/v1/contexts/${unknownContext}`), 404);
  denied(await fixture.request('alice', 'POST', '/v1/realms', { ...body, contextId: unknownContext }, discoveryKey()));
  const unreadableContext = await fixture.scoped('alice', ['realm:create', 'realm:read', 'space:manage']);
  status(await unreadableContext.request('GET', `/v1/contexts/${context.id}`), 404);
  denied(await unreadableContext.request('POST', '/v1/realms', body, discoveryKey()));
  const unmanagedSpace = await fixture.scoped('alice', ['realm:create', 'realm:read', 'context:read']);
  status(await unmanagedSpace.request('GET', `/v1/contexts/${context.id}`), 200);
  denied(await unmanagedSpace.request('POST', '/v1/realms', body, discoveryKey()));
  denied(await fixture.request('bob', 'POST', '/v1/realms', { ...body, spaceId: bobSpace.spaceId }, discoveryKey()));
  expect(await grants()).toEqual(afterGrants);
  expect(await controls()).toEqual(before);

  const created = await fixture.request('alice', 'POST', '/v1/realms', body, discoveryKey());
  const realm = status(created, 201).realm as { realmId: string; headRevisionId: string };
  expect(realm).toMatchObject({
    ...body,
    creator: original.alice.accountId,
    author: original.alice.accountId,
    state: 'active',
  });
  expect(typeof realm.realmId).toBe('string');
  expect(typeof realm.headRevisionId).toBe('string');
  expect(created.headers.get('location')).toBe(`/v1/realms/${realm.realmId}`);
  expect(created.headers.get('etag')).toBe(JSON.stringify(realm.headRevisionId));
  expect(status(await fixture.request('alice', 'GET', `/v1/realms/${realm.realmId}`), 200).realm).toEqual(realm);
  const afterRealm = await controls();
  denied(await fixture.request('alice', 'POST', '/v1/realms', body, discoveryKey()));
  expect(await controls()).toEqual(afterRealm);
}, 120_000);

test('Realm setup leaves scopes defaults existing Space setup and unscoped denial unchanged', async () => {
  const original = structuredClone(fixture.personas);
  const originalScopes = {
    alice: scopes('alice'),
    bob: scopes('bob'),
    outsider: scopes('outsider'),
    unscoped: scopes('unscoped'),
  };
  expect(originalScopes.unscoped).toEqual([]);
  expect((await fixture.inspect('SELECT "group" FROM access.exposure_opening ORDER BY "group"')).rows).toEqual([
    { group: 'collections' },
  ]);
  const beforeSpace = await grants();
  await fixture.setup.spaceCreation('outsider');
  const afterSpace = await grants();
  const spaceAdded = afterSpace.filter(
    (row) => !beforeSpace.some((prior) => JSON.stringify(prior) === JSON.stringify(row)),
  );
  expect(spaceAdded).toHaveLength(1);
  expect(spaceAdded).toMatchObject([
    {
      route: 0,
      resource_id: '00000000-0000-8000-8000-000000000000',
      subject_id: original.outsider.accountId,
      action: 'space:create',
    },
  ]);
  expect(afterSpace.filter((row) => row !== spaceAdded[0])).toEqual(beforeSpace);
  const before = await controls();
  // All and only the four existing account names are admitted; no bearer is reissued.
  for (const persona of ['bob', 'outsider', 'unscoped'] as const) {
    const prior = await grants();
    expect(await fixture.setup.realmCreation(persona)).toBeUndefined();
    const after = await grants();
    const added = after.filter((row) => !prior.some((old) => JSON.stringify(old) === JSON.stringify(row)));
    expect(added).toHaveLength(1);
    expect(added).toMatchObject([
      {
        route: 0,
        resource_id: '00000000-0000-8000-8000-000000000000',
        subject_id: original[persona].accountId,
        action: 'realm:create',
      },
    ]);
    expect(after.filter((row) => row !== added[0])).toEqual(prior);
    expect(scopes(persona)).toEqual(originalScopes[persona]);
    expect(await controls()).toEqual(before);
  }
  const context = status(
    await fixture.request('editor', 'POST', '/v1/contexts', { labels: { en: 'Unscoped control' } }, discoveryKey()),
    201,
  ).context as { id: string };
  const host = await space('alice', 'Unscoped denial host');
  const unchanged = await controls();
  const unchangedGrants = await grants();
  denied(
    await fixture.request(
      'unscoped',
      'POST',
      '/v1/realms',
      { spaceId: host.spaceId, title: 'Denied', visibility: 'public', contextId: context.id },
      discoveryKey(),
    ),
  );
  status(await fixture.request('alice', 'GET', '/v1/libraryEntries'), 403);
  status(
    await fixture.request(
      'alice',
      'POST',
      '/v1/progressSessions',
      { subjectId: context.id, mode: 'scalar_amount', unit: 'page', total: '20' },
      discoveryKey(),
    ),
    403,
  );
  expect(await controls()).toEqual(unchanged);
  expect(await grants()).toEqual(unchangedGrants);
  expect(fixture.personas).toEqual(original);
  for (const persona of Object.keys(original) as DiscoveryAccountName[])
    expect(scopes(persona)).toEqual(originalScopes[persona]);
  await fixture.close();
  for (const persona of ['alice', 'invented'] as const)
    await expect(fixture.setup.realmCreation(persona as DiscoveryAccountName)).rejects.toThrow('closed');
  expect(fixture.personas).toEqual(original);
}, 120_000);
