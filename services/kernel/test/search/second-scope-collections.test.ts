import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  createCollectionDiscoveryAdapter,
  createNativeCollectionDiscoveryAdapter,
  CollectionDiscoveryReadinessError,
  type PublicCollectionDiscoverySource,
} from '../../src/search/collection-discovery.ts';
import type { CollectionDiscoveryItem } from '../../src/library/collection-discovery-source.ts';
import { createCollectionPublicationEpisodes } from '../../src/library/collection-publication-episodes.ts';
import { createNativeDiscoveryRegistry, hydrateOwnerDiscoveryHits } from '../../src/search/discovery-hydration.ts';
import { mintReadTime, releaseOperationalTime, authoritativeTimeValue } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import {
  createCollectionRulesFixture,
  type CollectionRulesFixture,
} from '../library/support/collection-rules-fixture.ts';

const id = '00000000-0000-7000-8000-000000000010';
const key = (id: string) => ({ route: routeOf(id)!, id });
const stamp = { partition: 0, epoch: 2, position: '1' };
const unavailable = (id: string): CollectionDiscoveryItem => ({
  key: key(id),
  status: 'unavailable',
  reason: 'selected_publication_witness_unavailable',
});
const indexed: CollectionDiscoveryItem = {
  key: key(id),
  status: 'indexable',
  value: {
    kind: 'collection',
    key: key(id),
    revision: 900,
    title: 'Public',
    description: null,
    presentationKind: null,
    coverMediaId: null,
    membershipKind: 'curated',
    output: null,
  },
};
function adapter(overrides: Partial<PublicCollectionDiscoverySource> = {}) {
  return createCollectionDiscoveryAdapter({
    status: 'ready',
    source: {
      read: async (_partition, keys) => ({
        status: 'available',
        stamp,
        items: keys.map((k) => (k.id === id ? indexed : { key: k, status: 'withdrawn' })),
      }),
      page: async () => ({ status: 'available', stamp, items: [indexed], next: null }),
      count: async () => ({ status: 'unavailable', reason: 'native_collection_population_evidence_unavailable' }),
      ...overrides,
    },
    readSummaries: async () => ({ state: 'unavailable', reason: 'native_authority' }),
  });
}
function ready(value: ReturnType<typeof adapter>) {
  if (value.status !== 'ready') throw new Error('Expected installed adapter');
  return value;
}

test('native full keys, independent stamps, duplicate-inclusive bounds and unavailable census survive adaptation', async () => {
  expect(createCollectionDiscoveryAdapter(undefined).status).toBe('unavailable');
  expect(createCollectionDiscoveryAdapter({ status: 'preparing' }).status).toBe('preparing');
  const leaf = ready(adapter());
  const routedCollision = '00000000-0000-7000-8000-000100000010';
  expect(await leaf.source.read(0, [key(routedCollision), key(id), key(id)])).toEqual({
    status: 'available',
    stamp,
    items: [indexed, { key: key(routedCollision), status: 'withdrawn' }],
  });
  expect(await leaf.source.count(0)).toEqual({
    status: 'unavailable',
    reason: 'native_collection_population_evidence_unavailable',
  });
  await expect(leaf.source.read(0, Array(101).fill(key(id)))).rejects.toThrow('batch exceeds');
  await expect(leaf.source.read(0, [{ route: 1, id }])).rejects.toThrow('wrong full key');
  await expect(leaf.source.read(1, [key(id)])).rejects.toThrow('wrong full key');
  await expect(
    leaf.hydrate(Array(101).fill(id), { actor: { kind: 'anonymous' }, partition: 0, deadline: Date.now() + 1000 }),
  ).rejects.toThrow('batch exceeds');
  const partitionUnavailable = ready(
    adapter({ read: async () => ({ status: 'unavailable', reason: 'native_partition_unavailable' }) }),
  );
  expect(await partitionUnavailable.source.read(0, [key(id)])).toEqual({
    status: 'unavailable',
    reason: 'native_partition_unavailable',
  });
  const wrong = ready(adapter({ read: async () => ({ status: 'available', stamp, items: [] }) }));
  await expect(wrong.source.read(0, [key(id)])).rejects.toThrow('every requested full key');
});

test('full sparse and zero-eligible raw pages advance; short and empty pages exhaust', async () => {
  const second = '00000000-0000-7000-8000-000000000011';
  const last = '00000000-0000-7000-8000-000000000012';
  const rows = [indexed, unavailable(second), unavailable(last)];
  const leaf = ready(
    adapter({
      page: async (_partition, after, limit) => {
        const items = rows.slice(after ? rows.findIndex((row) => row.key.id === after.id) + 1 : 0).slice(0, limit);
        return { status: 'available', stamp, items, next: items.length === limit ? items.at(-1)!.key : null };
      },
    }),
  );
  expect(await leaf.source.page(0, null, 2)).toMatchObject({ items: rows.slice(0, 2), next: key(second) });
  expect(await leaf.source.page(0, key(second), 1)).toMatchObject({ items: [unavailable(last)], next: key(last) });
  expect(await leaf.source.page(0, key(last), 1)).toMatchObject({ items: [], next: null });
  expect(await leaf.source.page(0, key(second), 2)).toMatchObject({ items: [unavailable(last)], next: null });
  const inconsistent = ready(
    adapter({ page: async () => ({ status: 'available', stamp, items: rows.slice(0, 2), next: key(id) }) }),
  );
  await expect(inconsistent.source.page(0, null, 2)).rejects.toThrow('raw page');
});

describe('connected native Collection reader journey', () => {
  let f: CollectionRulesFixture;
  let actor: Actor;
  beforeAll(async () => {
    f = await createCollectionRulesFixture();
    actor = await f.runtime.identity.access.authenticate(f.owner, {
      pool: f.database.pool,
      deadline: Date.now() + 30000,
    });
  }, 120000);
  afterAll(async () => {
    await f?.close();
  });
  const deps = () => ({ pool: f.database.pool, access: f.runtime.identity.access });
  const context = (id: string) => ({
    actor: { kind: 'anonymous' } as const,
    partition: partitionOf(routeOf(id)!),
    deadline: Date.now() + 120000,
  });
  function connected() {
    const leaf = createNativeCollectionDiscoveryAdapter(deps(), {
      id: 'collection',
      labels: { en: 'Collections' },
      icon: 'collection',
    });
    const noRead = async (): Promise<never> => {
      throw new Error('Unrelated catalogue source was read');
    };
    const registry = createNativeDiscoveryRegistry({
      pool: f.database.pool,
      routeKey: new Uint8Array(32),
      release: bundledRelease,
      semantic: {
        source: { read: noRead, count: noRead },
        icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
      },
      accounts: { labels: { en: 'Accounts' }, icon: 'account' },
      ownerAdapters: {
        collection: leaf.registration,
        review: { readiness: 'unavailable' },
        space: { readiness: 'unavailable' },
      },
    });
    const current = (ids: string[], access: Access = f.runtime.identity.access) =>
      hydrateOwnerDiscoveryHits(
        registry,
        ids.map((id) => ({ owner: 'commerce' as const, kind: 'collection' as const, ...key(id) })),
        { access, actor: { kind: 'anonymous' }, deadline: Date.now() + 120000 },
      );
    return { leaf, current };
  }
  async function saved() {
    const response = await f.send('POST', '/v1/collections', {
      title: 'Selected output',
      visibility: 'private',
      membershipKind: 'dynamic',
      rule: { filter: { owner: { presence: true } }, sort: 'id' },
    });
    expect(response.status).toBe(201);
    return (await response.json()).collection as { id: string; revision: number };
  }

  test('curated current disclosure withdraws stale positives, restores identity, and distinguishes native changes and failures', async () => {
    const { leaf, current } = connected();
    const row = await f.collection({ visibility: 'public', title: 'Original', description: 'Public description' });
    const hidden = await f.collection({ visibility: 'unlisted' });
    const partition = partitionOf(routeOf(row.id)!);
    const positive = await leaf.source.read(partition, [key(row.id)]);
    expect(positive.status).toBe('available');
    const time = await withConnection(f.database.pool, (client) => mintReadTime(client));
    try {
      expect(
        await leaf.hydrate([row.id, hidden.id, row.id, newId(routeOf(row.id)!)], { ...context(row.id), time }),
      ).toMatchObject({
        state: 'ready',
        summaries: [{ id: row.id, destination: `/collections/${row.id}`, memberCount: 0, membershipKind: 'curated' }],
      });
      expect(authoritativeTimeValue(time)).toBeString();
    } finally {
      releaseOperationalTime(time);
    }
    expect(await current([row.id, hidden.id])).toMatchObject([
      { key: { ...key(row.id) }, summary: { value: { id: row.id, title: 'Original', summary: 'Public description' } } },
    ]);
    expect(
      (await f.send('PATCH', `/v1/collections/${row.id}`, { revision: row.revision, visibility: 'private' })).status,
    ).toBe(200);
    expect(await current([row.id])).toEqual([]);
    expect(await leaf.source.read(partition, [key(row.id)])).toMatchObject({
      items: [{ key: key(row.id), status: 'withdrawn' }],
    });
    const restored = await f.send('PATCH', `/v1/collections/${row.id}`, {
      revision: row.revision + 1,
      visibility: 'public',
    });
    expect(restored.status).toBe(200);
    const version = (await restored.json()).collection.revision;
    expect(await current([row.id])).toHaveLength(1);
    expect(await leaf.source.read(partition, [key(row.id)])).toMatchObject({
      items: [{ status: 'indexable', value: { revision: version } }],
    });
    // Mutations happen inside the actual reader's final authority round, not a replacement card reader.
    for (const change of ['title', 'unlisted', 'deleted'] as const) {
      const candidate = await f.collection({ visibility: 'public' });
      let rounds = 0;
      const access: Access = {
        ...f.runtime.identity.access,
        async prepareReadDecisions(input) {
          if (++rounds === 2) {
            const response =
              change === 'deleted'
                ? await f.send('DELETE', `/v1/collections/${candidate.id}?revision=${candidate.revision}`)
                : await f.send('PATCH', `/v1/collections/${candidate.id}`, {
                    revision: candidate.revision,
                    ...(change === 'title' ? { title: 'Changed' } : { visibility: 'unlisted' }),
                  });
            expect(response.status).toBe(change === 'deleted' ? 204 : 200);
          }
          return f.runtime.identity.access.prepareReadDecisions!(input);
        },
      };
      if (change === 'title')
        await expect(current([candidate.id], access)).rejects.toMatchObject({
          name: 'CollectionDiscoveryReadinessError',
          reason: 'changed',
        });
      else expect(await current([candidate.id], access)).toEqual([]);
    }
    const failure = new Error('Native infrastructure failed');
    await expect(
      current([row.id], {
        ...f.runtime.identity.access,
        prepareReadDecisions: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(await leaf.hydrate([row.id], { ...context(row.id), deadline: 0 })).toEqual({
      state: 'unavailable',
      reason: 'deadline',
    });
  }, 120000);

  test('completed empty A survives preparing B; no A and expired retained output never become successful empty cards', async () => {
    const { leaf, current } = connected();
    const a = await saved();
    const response = await f.send('POST', `/v1/collections/${a.id}:publishSelected`, {
      revision: a.revision,
      subjectIds: [],
    });
    expect(response.status).toBe(200);
    const published = await response.json();
    await createCollectionPublicationEpisodes(deps()).begin(
      actor,
      {
        collectionId: a.id,
        revision: published.collection.revision,
        visibility: 'public',
      },
      randomUUID(),
    );
    const cards = await leaf.hydrate([a.id], context(a.id));
    expect(cards).toMatchObject({
      state: 'ready',
      summaries: [{ id: a.id, membershipKind: 'dynamic', outputGeneration: published.publication.generation }],
    });
    if (cards.state !== 'ready') throw new Error('Completed A should remain current');
    for (const field of [
      'memberCount',
      'orderEpoch',
      'rule',
      'filter',
      'workingOutput',
      'curatorAccountId',
      'coverMediaId',
    ])
      expect(cards.summaries[0]).not.toHaveProperty(field);
    expect(await current([a.id])).toHaveLength(1);
    const noA = await saved();
    expect(
      (await f.send('PATCH', `/v1/collections/${noA.id}`, { revision: noA.revision, visibility: 'public' })).status,
    ).toBe(200);
    expect(await leaf.hydrate([noA.id], context(noA.id))).toEqual({ state: 'unavailable', reason: 'native_authority' });
    await expect(current([a.id, noA.id])).rejects.toBeInstanceOf(CollectionDiscoveryReadinessError);
    const partition = partitionOf(routeOf(a.id)!);
    let after = null as ReturnType<typeof key> | null;
    let sawNoA = false;
    do {
      const page = await leaf.source.page(partition, after, 1);
      if (page.status !== 'available') throw new Error('Fixture partition unavailable');
      if (page.items[0]?.key.id === noA.id) {
        expect(page.items[0].status).toBe('unavailable');
        expect(page.next).toEqual(key(noA.id));
        sawNoA = true;
      }
      after = page.next;
    } while (after);
    expect(sawNoA).toBe(true);
    // Expire the native deletion retention window; a retained output is never disclosure authority.
    const removed = await f.send('DELETE', `/v1/collections/${a.id}?revision=${published.collection.revision}`);
    expect(removed.status).toBe(204);
    await f.database.admin.query(
      "UPDATE library.collection SET purge_after=clock_timestamp()-interval '1 second' WHERE route=$1 AND collection_id=$2",
      [routeOf(a.id), a.id],
    );
    expect(await leaf.source.read(partition, [key(a.id)])).toMatchObject({
      items: [{ key: key(a.id), status: 'withdrawn' }],
    });
    expect(await leaf.hydrate([a.id], context(a.id))).toEqual({ state: 'ready', summaries: [] });
    expect(await current([a.id])).toEqual([]);
  }, 120000);
});
