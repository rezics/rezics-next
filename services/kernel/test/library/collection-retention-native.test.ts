import { afterAll, beforeAll, expect, test } from 'bun:test';
import { pageDueCollectionDeletions, purgeExpiredCollectionPage, type CollectionDeletionKey } from '../../src/library/collection-retention.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let now = Date.now();
const clock = () => new Date(now);
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
  owner = await f.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete']);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => { await f?.close(); });

async function make(visibility: 'private' | 'public' = 'private') {
  const r = await f.send(owner.bearer, 'POST', '/v1/collections', { title: 'Retained original', description: 'private payload', visibility });
  expect(r.status).toBe(201);
  return (await r.json()).collection;
}
async function current(id: string) {
  const r = await f.send(owner.bearer, 'GET', `/v1/collections/${id}`);
  expect(r.status).toBe(200);
  return (await r.json()).collection;
}
async function remove(id: string, revision: number, key = entryKey()) {
  const r = await f.send(owner.bearer, 'DELETE', `/v1/collections/${id}?revision=${revision}`, undefined, key);
  expect(r.status).toBe(204);
  const deletionId = r.headers.get('Library-Collection-Deletion-Id');
  if (!deletionId) throw new Error('Missing committed deletion episode');
  return { deletionId, revision: Number(r.headers.get('Library-Collection-Deletion-Revision')) };
}
async function locator(id: string): Promise<CollectionDeletionKey> {
  const row = (await f.pool.query<{ purgeAfter: string; deletionId: string; revision: number }>(
    'SELECT purge_after::text AS "purgeAfter", deletion_id::text AS "deletionId", revision FROM library.collection WHERE route=$1 AND collection_id=$2',
    [routeOf(id), id],
  )).rows[0];
  if (!row) throw new Error('Missing retained Collection');
  return { ...row, route: routeOf(id)!, collectionId: id, accountId: owner.actor.accountId };
}
async function snapshot(id: string) {
  return (await f.pool.query('SELECT to_jsonb(c) AS row FROM library.collection c WHERE route=$1 AND collection_id=$2', [routeOf(id), id])).rows;
}

test('exact Undo does not revive an independently deleted duplicate; D1 cannot restore or purge D3', async () => {
  const collection = await make(), id = collection.id;
  const subjectId = await f.createSubject('game');
  const added = [];
  for (const note of ['first', 'removed independently', 'last']) {
    const r = await f.send(owner.bearer, 'POST', `/v1/collections/${id}/members`, { subjectId, note });
    expect(r.status).toBe(201); added.push((await r.json()).member);
  }
  const removed = await f.send(owner.bearer, 'DELETE', `/v1/collections/${id}/members/${added[1].id}?revision=${(await current(id)).revision}`);
  expect(removed.status).toBe(204);
  const before = await current(id), receipt = entryKey();
  const first = await remove(id, before.revision, receipt), d1 = await locator(id);
  expect(await remove(id, before.revision, receipt)).toEqual(first);
  const restored = await f.send(owner.bearer, 'POST', `/v1/collections/${id}:restore`, first);
  expect(restored.status).toBe(200);
  const page = await f.send(owner.bearer, 'GET', `/v1/collections/${id}/members`);
  expect((await page.json()).members).toEqual([added[0], added[2]]);
  await remove(id, (await current(id)).revision);
  const d3 = await locator(id), beforeStale = await snapshot(id);
  expect(d3.deletionId).not.toBe(d1.deletionId);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, d1)).status).toBe('stale');
  expect((await f.send(owner.bearer, 'POST', `/v1/collections/${id}:restore`, first)).status).toBe(409);
  expect(await snapshot(id)).toEqual(beforeStale);
}, 120000);

test('due cleanup uses the original deadline, erases children before the head, and resumes exact pages', async () => {
  const row = await make(), subjectId = await f.createSubject('game');
  for (let i = 0; i < 65; i++) {
    const r = await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}/members`, { subjectId, note: `original ${i}` });
    expect(r.status).toBe(201);
  }
  await remove(row.id, (await current(row.id)).revision);
  const key = await locator(row.id), before = await snapshot(row.id);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).status).toBe('not_due');
  expect(await snapshot(row.id)).toEqual(before);
  now += 720 * 3600 * 1000;
  const keys = await pageDueCollectionDeletions(f.pool, { partition: partitionOf(key.route), cutoff: clock().toISOString(), after: null });
  expect(keys).toContainEqual(key);
  expect(Buffer.byteLength(JSON.stringify(keys))).toBeLessThanOrEqual(4096);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 64 });
  expect(await snapshot(row.id)).toEqual(before);
  expect((await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}:restore`, { deletionId: key.deletionId, revision: key.revision })).status).toBe(409);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 1 });
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'purged', removed: 1 });
  expect(await snapshot(row.id)).toEqual([]);
  expect((await f.pool.query('SELECT member_id FROM library.collection_member WHERE route=$1 AND collection_id=$2', [key.route, key.collectionId])).rows).toEqual([]);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).status).toBe('stale');
}, 120000);

test('public custody stays explicitly retained until actual Source and destination disposition are bound', async () => {
  const row = await make('public');
  await remove(row.id, row.revision);
  const key = await locator(row.id), before = await snapshot(row.id);
  now += 720 * 3600 * 1000;
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({
    status: 'retained', removed: 0, custody: 'collection_source_and_destination_disposition',
  });
  expect(await snapshot(row.id)).toEqual(before);
  expect((await f.send('anonymous', 'GET', `/v1/collections/${row.id}`)).status).toBe(404);
}, 120000);
