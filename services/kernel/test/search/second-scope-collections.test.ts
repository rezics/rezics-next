import { expect, test } from 'bun:test';
import {
  COLLECTION_DISCOVERY_BATCH_SIZE,
  CollectionDiscoveryReadinessError,
  createCollectionDiscoveryAdapter,
  type PublicCollectionDiscoverySource,
} from '../../src/search/collection-discovery.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const id = '00000000-0000-4000-8000-000000000010';
const otherId = '00000000-0000-4000-8000-000000000011';
const route = routeOf(id)!;
const partition = partitionOf(route);
const publicRow = { id, visibility: 'public' as const, revision: 7n, title: 'Public recipes', description: 'A public set' };

function readyAdapter(sourceOverrides: Partial<PublicCollectionDiscoverySource> = {}) {
  const source: PublicCollectionDiscoverySource = {
    read: async (requestedPartition, ids) => ({
      partition: requestedPartition,
      position: 8n,
      collections: ids.includes(id) ? [publicRow] : [],
    }),
    count: async (requestedPartition) => ({ partition: requestedPartition, position: 8n, count: 1 }),
    page: async (requestedPartition) => ({
      partition: requestedPartition,
      position: 8n,
      collections: [publicRow],
      complete: true,
      next: null,
    }),
    ...sourceOverrides,
  };
  return createCollectionDiscoveryAdapter({
    status: 'ready',
    source,
    async readSummaries(ids) {
      return new Map(
        ids.includes(id)
          ? [[id, { id, title: 'Current public title', description: null, destination: `/collections/${id}`, privateRules: ['hidden'] } as never]]
          : [],
      );
    },
  });
}

test('missing native coverage stays unavailable or preparing', () => {
  expect(createCollectionDiscoveryAdapter(undefined)).toEqual({
    status: 'unavailable',
    reason: 'commerce_collection_discovery_producer_not_installed',
  });
  expect(createCollectionDiscoveryAdapter({ status: 'preparing' })).toEqual({
    status: 'preparing',
    reason: 'commerce_collection_discovery_preparing',
  });
});

test('ready adapter bounds full-key reads and returns current authorized summaries without extra fields', async () => {
  const adapter = readyAdapter();
  expect(adapter.status).toBe('ready');
  if (adapter.status !== 'ready') return;

  expect(await adapter.source.read(partition, [id])).toEqual({ partition, position: 8n, collections: [publicRow] });
  expect(await adapter.source.count(partition)).toEqual({ partition, position: 8n, count: 1 });
  expect(await adapter.source.page(partition, null, 1)).toEqual({
    partition,
    position: 8n,
    collections: [publicRow],
    complete: true,
    next: null,
  });
  await expect(adapter.source.read(partition, Array.from({ length: COLLECTION_DISCOVERY_BATCH_SIZE + 1 }, () => id))).rejects.toThrow(
    'batch exceeds its bound',
  );

  const context = { actor: 'current viewer' };
  expect(await adapter.hydrate([id], context)).toEqual(
    new Map([[id, { id, title: 'Current public title', description: null, destination: `/collections/${id}` }]]),
  );
});

test('rejects wrong keys, private rows, and revisions beyond their native snapshot', async () => {
  const wrongRead = readyAdapter({
    read: async (requestedPartition) => ({ partition: requestedPartition, position: 8n, collections: [{ ...publicRow, id: otherId }] }),
  });
  if (wrongRead.status !== 'ready') throw new Error('Expected a ready adapter');
  await expect(wrongRead.source.read(partition, [id])).rejects.toThrow('wrong full key');

  const privateRead = readyAdapter({
    read: async (requestedPartition) => ({
      partition: requestedPartition,
      position: 8n,
      collections: [{ ...publicRow, visibility: 'unlisted' } as never],
    }),
  });
  if (privateRead.status !== 'ready') throw new Error('Expected a ready adapter');
  await expect(privateRead.source.read(partition, [id])).rejects.toThrow('Invalid public Collection discovery row');

  const futureRevision = readyAdapter({
    page: async (requestedPartition) => ({
      partition: requestedPartition,
      position: 8n,
      collections: [{ ...publicRow, revision: 9n }],
      complete: true,
      next: { route, id },
    }),
  });
  if (futureRevision.status !== 'ready') throw new Error('Expected a ready adapter');
  await expect(futureRevision.source.page(partition, null, 1)).rejects.toThrow('native position');
});

test('does not expose a frontier for incomplete or inconsistent producer pages', async () => {
  const incomplete = readyAdapter({
    page: async (requestedPartition) => ({
      partition: requestedPartition,
      position: 8n,
      collections: [publicRow],
      complete: false,
      next: { route, id },
    }),
  });
  if (incomplete.status !== 'ready') throw new Error('Expected a ready adapter');
  await expect(incomplete.source.page(partition, null, 1)).rejects.toBeInstanceOf(CollectionDiscoveryReadinessError);

  const wrongFrontier = readyAdapter({
    page: async (requestedPartition) => ({
      partition: requestedPartition,
      position: 8n,
      collections: [publicRow],
      complete: true,
      next: { route: route + 1, id },
    }),
  });
  if (wrongFrontier.status !== 'ready') throw new Error('Expected a ready adapter');
  await expect(wrongFrontier.source.page(partition, null, 1)).rejects.toThrow('wrong full key');
});
