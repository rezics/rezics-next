import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createBody, page, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const path = (id: string) => `/v1/zones/${id}`;

test('resource validation uses immutable saved-filter IDs and the composition admission limits without effects', async () => {
  const valid = createBody();
  const invalid = [
    { ...valid, configuration: { ...valid.configuration, scope: ['missing:filter'] } },
    {
      ...valid,
      configuration: {
        ...valid.configuration,
        pages: [
          { route: '', document: page('Home') },
          { route: 'subjects', document: page('Shadow') },
        ],
      },
    },
    {
      ...valid,
      configuration: {
        ...valid.configuration,
        pages: [
          { route: '', document: page('Home') },
          { route: 'subjects/hidden', document: page('Shadow') },
        ],
      },
    },
    { ...valid, configuration: { ...valid.configuration, pages: [{ route: '', document: page('x'.repeat(70_000)) }] } },
    {
      ...valid,
      configuration: {
        ...valid.configuration,
        pages: [
          {
            route: '',
            document: { root: { props: {} }, content: [{ type: 'Execute', props: { id: 'bad', script: 'alert(1)' } }] },
          },
        ],
      },
    },
    { ...valid, mounts: Array.from({ length: 17 }, () => f.accounts.other) },
    { ...valid, unexpected: true },
  ];
  const before = await f.receipts();
  for (const input of invalid) expect((await f.call('owner', 'POST', '/v1/zones', input)).status).toBe(400);
  expect(await f.receipts()).toBe(before);
  const created = await f.call('owner', 'POST', '/v1/zones', valid);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const made = created.body.zone as { id: string };
  const raw = await f.raw(made.id);
  expect(raw!.release_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(raw!.owner_id).toBe(f.accounts.owner);
  expect(raw!.route).toBe(routeOf(f.accounts.owner));
  const beforeEvents = await f.events(made.id);
  const bad = structuredClone(valid.configuration);
  bad.scope = ['unknown:filter'];
  expect(
    (
      await f.call(
        'owner',
        'PUT',
        `${path(made.id)}/configuration`,
        { configuration: bad, mounts: [] },
        f.conditional('1'),
      )
    ).status,
  ).toBe(400);
  expect(await f.raw(made.id)).toEqual(raw);
  expect(await f.events(made.id)).toEqual(beforeEvents);
});

test('quoted conditional headers are strict and publish replay retains original revision and event', async () => {
  const input = createBody();
  input.configuration.scope = [];
  const zone = await f.create(input);
  for (const match of ['', '*', '1', 'W/"1"', '"01"', '"1", "2"', '"9223372036854775808"']) {
    expect(
      (await f.call('owner', 'POST', `${path(zone.id)}:publish`, { visibility: 'public' }, { 'if-match': match }))
        .status,
    ).toBe(400);
  }
  const headers = { ...f.conditional('1'), 'idempotency-key': JSON.stringify(randomUUID()) };
  const published = await f.call('owner', 'POST', `${path(zone.id)}:publish`, { visibility: 'public' }, headers);
  expect(published.status).toBe(200);
  const changed = await f.call(
    'owner',
    'POST',
    `${path(zone.id)}:publish`,
    { visibility: 'private' },
    f.conditional('2'),
  );
  expect(changed.status).toBe(200);
  const replay = await f.call('owner', 'POST', `${path(zone.id)}:publish`, { visibility: 'public' }, headers);
  expect(replay.body).toEqual(published.body);
  expect(replay.headers.get('etag')).toBe('"2"');
  expect((await f.events(zone.id)).filter((e) => e.type === 'com.rezics.zone.published.v1')).toHaveLength(2);
  const badAuth = await f.call('anonymous', 'GET', path(zone.id), undefined, { authorization: 'Bearer invalid' });
  expect(badAuth.status).toBe(401);
});

test('Collection mounts use the caller current source read and a revoked source blocks fresh configuration', async () => {
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'gate:collections');
  const source = await f.call('owner', 'POST', '/v1/collections', { title: 'Private source', visibility: 'private' });
  expect(source.status).toBe(201);
  const collection = source.body.collection;
  const input = createBody();
  input.configuration.scope = [];
  input.mounts = [collection.id];
  const zone = await f.create(input);
  await f.grant(zone.id, 'editor', 'zone:configure');
  const denied = await f.call(
    'editor',
    'PUT',
    `${path(zone.id)}/configuration`,
    { configuration: input.configuration, mounts: [collection.id] },
    f.conditional('1'),
  );
  expect(denied.status).toBe(404);
  await f.access.grant({ route: routeOf(collection.id)!, id: collection.id }, 'editor', 'collection:read');
  const edit = await f.call(
    'editor',
    'PUT',
    `${path(zone.id)}/configuration`,
    { configuration: input.configuration, mounts: [collection.id] },
    f.conditional('1'),
  );
  expect(edit.status).toBe(200);
  await f.access.revoke({ route: routeOf(collection.id)!, id: collection.id }, 'editor', 'collection:read');
  expect(
    (
      await f.call(
        'editor',
        'PUT',
        `${path(zone.id)}/configuration`,
        { configuration: input.configuration, mounts: [collection.id] },
        f.conditional('2'),
      )
    ).status,
  ).toBe(404);
  expect((await f.raw(zone.id))!.revision).toBe('2');
});

test('owned listing is raw-key bounded and binds its cursor to viewer, filter, limit and security', async () => {
  const input = createBody();
  input.configuration.scope = [];
  const first = await f.create(input);
  const second = await f.create(input);
  const listing = await f.call('owner', 'GET', '/v1/zones?limit=1');
  expect(listing.status).toBe(200);
  expect(listing.body.next).toBeString();
  const token = encodeURIComponent(listing.body.next);
  expect((await f.call('owner', 'GET', `/v1/zones?limit=1&cursor=${token}`)).status).toBe(200);
  expect((await f.call('other', 'GET', `/v1/zones?limit=1&cursor=${token}`)).status).toBe(400);
  expect((await f.call('owner', 'GET', `/v1/zones?limit=2&cursor=${token}`)).status).toBe(400);
  expect((await f.call('owner', 'GET', `/v1/zones?limit=1&deleted=true&cursor=${token}`)).status).toBe(400);
  await f.call('owner', 'POST', `${path(second.id)}:publish`, { visibility: 'unlisted' }, f.conditional('1'));
  expect((await f.call('owner', 'GET', `/v1/zones?limit=1&cursor=${token}`)).status).toBe(409);
  // Remove the actual ordinary role while retaining attribution and generic read. Metadata identity is not authority.
  await f.db.admin.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    routeOf(first.id),
    first.id,
    f.accounts.owner,
  ]);
  await f.grant(first.id, 'owner', 'zone:read');
  expect((await f.call('owner', 'GET', path(first.id))).status).toBe(200);
  expect((await f.call('owner', 'GET', `${path(first.id)}/configuration`)).status).toBe(403);
  const owned = await f.call('owner', 'GET', '/v1/zones?limit=100');
  expect(owned.body.zones.some((z: { id: string }) => z.id === first.id)).toBe(false);
  await f.grant(first.id, 'editor', 'zone:restore');
  expect((await f.call('editor', 'POST', `${path(first.id)}:restore`, {}, f.conditional('1'))).status).toBe(403);
});

test('verified suspension is forbidden on Zones while other authentication contracts and bad bearer stay unchanged', async () => {
  const input = createBody();
  input.configuration.scope = [];
  const zone = await f.create(input);
  expect((await f.call('suspended', 'GET', path(zone.id))).status).toBe(403);
  expect((await f.call('suspended', 'POST', '/v1/zones', input)).status).toBe(403);
  expect((await f.call('suspended', 'GET', `/v1/collections/${zone.id}`)).status).toBe(401);
  expect((await f.call('suspended', 'GET', path(zone.id), undefined, { authorization: 'Bearer invalid' })).status).toBe(
    401,
  );
});

test('terminal account confirmation refuses new Zone writes and authorized receipt replay', async () => {
  const input = createBody();
  input.configuration.scope = [];
  const key = { 'idempotency-key': JSON.stringify(randomUUID()) };
  const made = await f.call('owner', 'POST', '/v1/zones', input, key);
  expect(made.status).toBe(201);
  await f.tombstoneOwner();
  const before = await f.events(made.body.zone.id);
  expect((await f.call('owner', 'POST', '/v1/zones', input, key)).status).toBe(401);
  expect(
    (await f.call('owner', 'POST', `${path(made.body.zone.id)}:publish`, { visibility: 'public' }, f.conditional('1')))
      .status,
  ).toBe(401);
  expect(await f.events(made.body.zone.id)).toEqual(before);
});
