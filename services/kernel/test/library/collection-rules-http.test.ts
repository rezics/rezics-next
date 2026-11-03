import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
const presence = { owner: { presence: true } };
const draft = (filter: unknown = presence) => ({
  membershipKind: 'dynamic',
  title: 'Saved books',
  visibility: 'private',
  rule: { filter },
});
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('a curator creates and edits a saved rule with native CAS, exact replay and real useful members', async () => {
  const subjectId = await f.subject('Saved rule matching Book');
  // A copy is a Library fact without an entry state.
  const copy = await f.send('POST', '/v1/copies', {
    subjectId,
    status: 'owned',
    location: 'Shelf',
    source: 'Personal purchase',
    acquiredOn: '2026-11-03',
    disposedOn: null,
  });
  expect(copy.status).toBe(201);
  const key = randomUUID();
  const input = draft();
  const created = await f.send('POST', '/v1/collections', input, f.owner, key);
  expect(created.status).toBe(201);
  const body = await created.json();
  const collection = body.collection;
  expect(collection).toMatchObject({ membershipKind: 'dynamic', revision: 1, title: input.title });
  for (const field of ['memberCount', 'orderEpoch', 'createdAt', 'updatedAt', 'filter', 'rule', 'builtinKind'])
    expect(collection).not.toHaveProperty(field);
  const replay = await f.send('POST', '/v1/collections', input, f.owner, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(body);
  expect(
    (await f.send('POST', '/v1/collections', { ...input, rule: { filter: { not: presence } } }, f.owner, key)).status,
  ).toBe(422);
  expect((await f.page(collection.id)).members).toEqual([{ kind: 'dynamic', subjectId }]);

  const path = `/v1/collections/${collection.id}/rule`;
  const update = { revision: 1, filter: { and: [presence, { type: { in: ['schema:Book'] } }] }, sort: 'id' };
  const editKey = randomUUID();
  const changed = await f.send('PUT', path, update, f.owner, editKey);
  expect(changed.status).toBe(200);
  const edited = await changed.json();
  expect(edited.collection.revision).toBe(2);
  const editReplay = await f.send('PUT', path, update, f.owner, editKey);
  expect(editReplay.status).toBe(200);
  expect(await editReplay.json()).toEqual(edited);
  expect((await f.send('PUT', path, update)).status).toBe(409);
  expect((await f.send('PUT', path, { ...update, filter: { not: presence } }, f.owner, editKey)).status).toBe(422);
  expect((await f.send('POST', `/v1/collections/${collection.id}/members`, { subjectId })).status).toBe(409);
  const metadata = await f.send('PATCH', `/v1/collections/${collection.id}`, { revision: 2, title: 'Renamed' });
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).collection).not.toHaveProperty('memberCount');
  expect((await f.page(collection.id)).members).toEqual([{ kind: 'dynamic', subjectId }]);
}, 120_000);

test('rule replay rechecks private family scopes and hidden/unknown/builtin targets stay closed', async () => {
  const created = await f.send('POST', '/v1/collections', draft());
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const path = `/v1/collections/${collection.id}/rule`;
  const input = { revision: collection.revision, filter: presence };
  const key = randomUUID();
  expect((await f.send('PUT', path, input, f.owner, key)).status).toBe(200);
  expect((await f.send('PUT', path, input, f.reduced, key)).status).toBe(403);
  for (const bearer of [f.other, null]) {
    expect((await f.send('PUT', path, input, bearer)).status).toBe(bearer === null ? 401 : 404);
    const unknown = newId(routeOf(collection.id)!);
    expect((await f.send('PUT', `/v1/collections/${unknown}/rule`, input, bearer)).status).toBe(
      bearer === null ? 401 : 404,
    );
  }
  const builtin = builtinCollectionId(f.runtime.identity.ordinary.accountId, { kind: 'everything' });
  expect((await f.send('PUT', `/v1/collections/${builtin}/rule`, { revision: 0, filter: presence })).status).toBe(409);
}, 120_000);

test('rule and create bodies reject selectors and the shared grammar remains strict under NOT', async () => {
  for (const body of [
    { ...draft(), ownerAccountId: f.runtime.identity.ordinary.accountId },
    { ...draft(), principal: 'self' },
    { ...draft(), rule: { filter: { owner: { presence: true, accountId: 'other' } } } },
    { ...draft(), rule: { filter: { not: { owner: { presence: true }, route: 1 } } } },
    { ...draft(), rule: { filter: presence, source: 'private' } },
    { ...draft(), rule: { filter: presence, sort: { field: 'privateCount' } } },
  ])
    expect((await f.send('POST', '/v1/collections', body)).status).toBe(400);
  expect(
    (await f.send('POST', '/v1/collections', { ...draft(), rule: { filter: presence, sort: 'unknown' } })).status,
  ).toBe(422);
}, 120_000);

test('clear and Undo change actual saved membership without changing its retained rule', async () => {
  const subjectId = await f.subject('Clear and Undo source');
  const entry = await f.entry(subjectId);
  const created = await f.send('POST', '/v1/collections', draft());
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  expect((await f.page(collection.id)).members).toContainEqual({ kind: 'dynamic', subjectId });
  const removed = await f.send(
    'DELETE',
    `/v1/libraryEntries/${subjectId}?revision=${entry.revision}&incarnationId=${entry.incarnationId}`,
  );
  expect(removed.status).toBe(204);
  expect((await f.page(collection.id)).members).not.toContainEqual({ kind: 'dynamic', subjectId });
  const restored = await f.send('POST', `/v1/libraryEntries/${subjectId}:restore`, {
    deletionId: removed.headers.get('Library-Entry-Deletion-Id'),
    revision: Number(removed.headers.get('Library-Entry-Deletion-Revision')),
  });
  expect(restored.status).toBe(200);
  expect((await f.page(collection.id)).members).toContainEqual({ kind: 'dynamic', subjectId });
}, 120_000);

test('public saved execution is explicitly unavailable without the complete Publication provider', async () => {
  const response = await f.send('POST', '/v1/collections', { ...draft(), visibility: 'public' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
}, 120_000);

test('native suspension rejects a previously issued editor bearer and its old receipt', async () => {
  const createKey = randomUUID();
  const input = draft();
  const created = await f.send('POST', '/v1/collections', input, f.owner, createKey);
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const suspended = await f.send(
    'POST',
    `/v1/accounts/${f.runtime.identity.ordinary.accountId}:suspend`,
    { reason: 'Current saved rule editor authority' },
    f.manager.bearer,
  );
  expect(suspended.status).toBe(200);
  expect((await f.send('POST', '/v1/collections', input, f.owner, createKey)).status).toBe(401);
  const denied = await f.send('PUT', `/v1/collections/${collection.id}/rule`, { revision: 1, filter: presence });
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(await denied.json()).toMatchObject({ code: 'invalid_credentials' });
}, 120_000);
