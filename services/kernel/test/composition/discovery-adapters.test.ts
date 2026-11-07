import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';
import type { CollectionDiscoverySource } from '../../src/library/collection-discovery-source.ts';
import { createDiscoveryOwnerAdapters } from '../../src/composition/discovery-adapters.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { SpaceDiscoveryAdapter } from '../../src/search/space-discovery.ts';

test('Space metadata uses the native source position as its discovery revision', async () => {
  const spaceId = newId(16);
  const revisionId = newId(17);
  const partition = partitionOf(routeOf(spaceId)!);
  const spaces = [
    {
      id: spaceId,
      realmId: null,
      address: null,
      title: 'Current Space',
      realmTitle: null,
      name: 'Current Space',
      description: 'Current description',
      revision: revisionId,
    },
  ];
  const space = {
    owner: 'content',
    kind: 'space',
    source: {
      async dependencies() {
        return { state: 'ready' };
      },
      async read() {
        return { partition, position: 44n, spaces };
      },
      async count() {
        return { partition, position: 44n, count: spaces.length };
      },
      async page() {
        return { partition, position: 44n, spaces, next: null };
      },
    },
    async hydrate() {
      return new Map();
    },
    project() {
      return [];
    },
    async preparePage() {
      throw new Error('Space metadata producer does not prepare native pages');
    },
  } as unknown as SpaceDiscoveryAdapter;
  const collectionSource: CollectionDiscoverySource = {
    async read(partition) {
      return { status: 'available', stamp: { partition, epoch: 0, position: '0' }, items: [] };
    },
    async page(partition) {
      return {
        status: 'available',
        stamp: { partition, epoch: 0, position: '0' },
        items: [],
        next: null,
      };
    },
    async count() {
      return { status: 'unavailable', reason: 'native_collection_population_evidence_unavailable' };
    },
  };
  const adapters = createDiscoveryOwnerAdapters({
    pool: {} as Pool,
    routeKey: new Uint8Array(32),
    access: {} as Access,
    clock: () => new Date(0),
    collectionSource,
    space,
  });

  const page = await adapters.metadataProducers.space!.page(partition, null, null, 10);
  expect(page.records[0]?.revision).toBe(44n);
  expect(spaces[0]?.revision).toBe(revisionId);
});
