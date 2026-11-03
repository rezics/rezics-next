import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  publicCollectionDiscoverySource,
  type CollectionDiscoveryKey,
  type CollectionDiscoverySnapshot,
} from '../../src/library/collection-discovery-source.ts';
import { createCollectionPublicationEpisodes } from '../../src/library/collection-publication-episodes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => { f = await createCollectionRulesFixture(); }, 120_000);
afterAll(async () => { await f?.close(); });
const key = (id: string): CollectionDiscoveryKey => ({ route: routeOf(id)!, id });
function available(snapshot: CollectionDiscoverySnapshot) {
  if (snapshot.status !== 'available') throw new Error('Native Collection partition unavailable');
  return snapshot;
}
async function saved() {
  const response = await f.send('POST', '/v1/collections', {
    title: 'Public selected output', description: 'Ordinary public description', visibility: 'private',
    membershipKind: 'dynamic', rule: { filter: { owner: { presence: true } } },
  });
  expect(response.status).toBe(201);
  return (await response.json()).collection as { id: string; revision: number };
}

test('native public hints exclude hidden/incomplete sources, retain selected A during B and withdraw before delayed delivery', async () => {
  const source = publicCollectionDiscoverySource({ pool: f.database.pool });
  const curated = await f.collection({ visibility: 'public' });
  const hidden = await f.collection({ visibility: 'private' });
  const unlisted = await f.collection({ visibility: 'unlisted' });
  const deleted = await f.collection({ visibility: 'public' });
  expect((await f.send('DELETE', `/v1/collections/${deleted.id}?revision=${deleted.revision}`)).status).toBe(204);
  const incomplete = await saved();
  expect((await f.send('PATCH', `/v1/collections/${incomplete.id}`, {
    revision: incomplete.revision, visibility: 'public',
  })).status).toBe(200);
  const privateDynamic = await saved();
  const unlistedDynamic = await saved();
  expect((await f.send('PATCH', `/v1/collections/${unlistedDynamic.id}`, {
    revision: unlistedDynamic.revision, visibility: 'unlisted',
  })).status).toBe(200);
  const dynamic = await saved();
  const selected = await f.subject('Selected public subject');
  const privateMatch = await f.subject('Unselected private match');
  await f.entry(selected);
  await f.entry(privateMatch);
  const input = { revision: dynamic.revision, subjectIds: [selected] };
  const requestKey = randomUUID();
  const published = await f.send('POST', `/v1/collections/${dynamic.id}:publishSelected`, input, f.owner, requestKey);
  expect(published.status).toBe(200);
  const output = await published.json();
  const partition = partitionOf(routeOf(curated.id)!);
  const ids = [curated, hidden, unlisted, deleted, incomplete, privateDynamic, unlistedDynamic, dynamic].map(({ id }) => key(id));
  const first = available(await source.read(partition, ids));
  const byId = new Map(first.items.map((item) => [item.key.id, item]));
  expect(byId.get(curated.id)).toMatchObject({ status: 'indexable', value: { membershipKind: 'curated', output: null } });
  for (const id of [hidden.id, unlisted.id, deleted.id, privateDynamic.id, unlistedDynamic.id]) expect(byId.get(id)).toEqual({ key: key(id), status: 'withdrawn' });
  expect(byId.get(incomplete.id)).toMatchObject({ status: 'unavailable' });
  expect(byId.get(dynamic.id)).toEqual({
    key: key(dynamic.id), status: 'indexable', value: {
      kind: 'collection', key: key(dynamic.id), revision: output.collection.revision,
      title: 'Public selected output', description: 'Ordinary public description',
      presentationKind: null, coverMediaId: null, membershipKind: 'dynamic',
      output: { route: routeOf(dynamic.id)!, collectionId: dynamic.id, generation: output.publication.generation },
    },
  });
  expect(JSON.stringify(first)).not.toContain(privateMatch);
  expect(JSON.stringify(first)).not.toContain(selected);
  expect((await f.send('POST', `/v1/collections/${dynamic.id}:publishSelected`, input, f.owner, requestKey)).status).toBe(200);
  expect(available(await source.read(partition, ids)).items).toEqual(first.items);

  const actor = await f.runtime.identity.access.authenticate(f.owner, { pool: f.database.pool, deadline: Date.now() + 30_000 });
  const begun = await createCollectionPublicationEpisodes({ pool: f.database.pool, access: f.runtime.identity.access }).begin(
    actor, { collectionId: dynamic.id, revision: output.collection.revision, visibility: 'public' }, randomUUID(),
  );
  expect(begun.value.locator.collectionId).toBe(dynamic.id);
  expect(available(await source.read(partition, [key(dynamic.id)])).items[0]).toEqual(byId.get(dynamic.id)!);

  async function walk() {
    const rebuilt = publicCollectionDiscoverySource({ pool: f.database.pool });
    const items = [];
    let after: CollectionDiscoveryKey | null = null;
    do {
      const page = await rebuilt.page(partition, after, 1);
      expect(page.status).toBe('available');
      if (page.status !== 'available') throw new Error('Native page unavailable');
      expect(page.items.length).toBeLessThanOrEqual(1);
      items.push(...page.items);
      after = page.next;
    } while (after !== null);
    return items;
  }
  const before = await walk();
  expect(await walk()).toEqual(before);
  expect(before.filter((item) => item.status === 'indexable').map((item) => item.key.id)).toContain(curated.id);
  expect(before.filter((item) => item.status === 'indexable').map((item) => item.key.id)).toContain(dynamic.id);
  for (const id of [hidden.id, unlisted.id, deleted.id, privateDynamic.id, unlistedDynamic.id]) expect(before.map((item) => item.key.id)).not.toContain(id);
  expect(await source.count(partition)).toEqual({ status: 'unavailable', reason: 'native_collection_population_evidence_unavailable' });

  const positive = available(await source.read(partition, [key(curated.id)]));
  expect((await f.send('PATCH', `/v1/collections/${curated.id}`, { revision: curated.revision, visibility: 'private' })).status).toBe(200);
  // A delayed positive event supplies a key only. Native truth wins on every delivery, including repeats.
  const withdrawal = available(await source.read(partition, [key(curated.id)]));
  expect(withdrawal.items).toEqual([{ key: key(curated.id), status: 'withdrawn' }]);
  expect(BigInt(withdrawal.stamp.position)).toBeGreaterThan(BigInt(positive.stamp.position));
  expect(available(await publicCollectionDiscoverySource({ pool: f.database.pool }).read(partition, [key(curated.id)])).items).toEqual(withdrawal.items);
  const native = (await f.database.admin.query('SELECT epoch,position::text FROM core.partition WHERE partition_no=$1', [partition])).rows[0];
  expect(withdrawal.stamp.epoch).toBe(native.epoch);
  expect(BigInt(withdrawal.stamp.position)).toBeLessThanOrEqual(BigInt(native.position));
  expect(available(await source.read(partition, [key(newId(routeOf(curated.id)!))])).items[0]?.status).toBe('withdrawn');
}, 120_000);

test('full keys, one partition and a maximum of 100 raw keys are required before IO', async () => {
  const source = publicCollectionDiscoverySource({ pool: f.database.pool });
  const id = newId(32), locator = key(id);
  await expect(source.read(2, Array(101).fill(locator))).rejects.toThrow();
  await expect(source.read(3, [locator])).rejects.toThrow();
  await expect(source.read(2, [{ ...locator, route: 33 }])).rejects.toThrow();
  await expect(source.page(2, locator, 101)).rejects.toThrow();
  await expect(source.page(2, key(newId(48)), 1)).rejects.toThrow();
  await expect(source.count(4096)).rejects.toThrow();
});


test('native continuation preserves route before UUID order, including empty suffixes after rebuild', async () => {
  const partition = partitionOf(routeOf(f.runtime.identity.ordinary.accountId)!);
  const route = partition * 16;
  const ids = [
    `ffffffff-0000-7000-8000-${route.toString(16).padStart(4, '0')}00000001`,
    `00000000-0000-7000-8000-${(route + 1).toString(16).padStart(4, '0')}00000001`,
  ];
  // Native seed isolates the route-order edge from owner allocation (one owner always shares a route).
  for (const id of ids) await f.database.admin.query(
    `INSERT INTO library.collection(route,collection_id,title,visibility,state,revision,created_at,updated_at,transaction_id)
     VALUES($1,$2,'Retained public metadata','public','active',1,now(),now(),$3)`,
    [routeOf(id), id, randomUUID()],
  );
  const source = publicCollectionDiscoverySource({ pool: f.database.pool });
  const read = available(await source.read(partition, ids.map(key).reverse()));
  expect(read.items.map((item) => item.key.id)).toEqual(ids);
  const after = { route, id: `fffffffe-ffff-7fff-bfff-${route.toString(16).padStart(4, '0')}ffffffff` };
  const first = await source.page(partition, after, 1);
  expect(available(first).items[0]?.key.id).toBe(ids[0]);
  expect(first.next).toEqual(key(ids[0]!));
  const resumed = await publicCollectionDiscoverySource({ pool: f.database.pool }).page(partition, first.next, 100);
  expect(available(resumed).items[0]?.key.id).toBe(ids[1]);
  const end = await source.page(partition, { route: route + 15, id: `ffffffff-ffff-7fff-bfff-${(route + 15).toString(16).padStart(4, '0')}ffffffff` }, 100);
  expect(available(end).items).toEqual([]);
  expect(end.next).toBeNull();
});
