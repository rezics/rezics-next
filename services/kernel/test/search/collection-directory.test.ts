import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { PublicCollectionDiscoverySummary } from '../../src/library/index.ts';
import type {
  CollectionDiscoveryItem,
  CollectionDiscoverySource,
} from '../../src/library/collection-discovery-source.ts';
import type { PublicCollectionDiscoveryOperand } from '../../src/library/collection-discovery-summaries.ts';
import {
  COLLECTION_DIRECTORY_SCAN_BOUND,
  collectionDirectoryOrder,
  collectionDirectoryPartitions,
  collectionDirectoryQuery,
  collectionDirectoryRows,
  consumeCollectionDirectoryFrontier,
  executeCollectionDirectory,
  hasCollectionDirectoryCapability,
  pageCollectionDirectory,
  parseCollectionDirectoryAfter,
  projectCollectionDirectoryHit,
  sortCollectionDirectory,
  type CollectionDirectoryRow,
} from '../../src/search/collection-directory.ts';
import {
  COLLECTION_DISCOVERY_BATCH_SIZE,
  CollectionDiscoveryReadinessError,
} from '../../src/search/collection-discovery.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { createDiscoverySearch } from '../../src/search/discovery-service.ts';
import type { DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from '../../src/search/discovery.ts';
import { installPublicFilterCoveragePage } from '../../src/search/public-filter-coverage-page.ts';
import type { PublicDiscoveryConsumerOperations } from '../../src/search/public-filter-consumer-contract.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import type { Access } from '../../src/request/access.ts';

const older = '018f0000-0000-7000-8000-00a000000001';
const newer = '018f0000-0000-7000-8000-00a000000002';
const popular = '018f0000-0000-7000-8000-00a000000003';
const inserted = '018f0000-0000-7000-8000-00a000000004';
const route = 160;
const partition = 10;
const stamp = { partition, epoch: 2, position: '7' };
const unused = async (): Promise<never> => {
  throw new Error('Unexpected producer operation');
};

function card(id: string): PublicCollectionDiscoverySummary {
  return {
    id,
    title: id,
    description: null,
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    curator: { state: 'unavailable', reason: 'deidentified' },
    preview: { state: 'empty' },
    kind: 'collection',
    destination: `/collections/${id}`,
    visibility: 'public',
    revision: 1,
    sourceGeneration: '1',
    membershipKind: 'curated',
    memberCount: 0,
    orderEpoch: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function row(
  id: string,
  operand: Pick<PublicCollectionDiscoveryOperand, 'recency' | 'popularity'>,
): CollectionDirectoryRow {
  const summary: DiscoveryOwnerMetadataSummary<'collection'> = {
    id,
    title: id,
    summary: null,
    revision: '1',
    sourcePosition: '1',
    queryObservation: 'b'.repeat(64),
    card: card(id),
    operands: {
      id,
      presentationKind: { kind: 'mixed' },
      curator: { state: 'unavailable', reason: 'deidentified' },
      subjectMembership: null,
      eligible: { presentationKind: true, curator: true, subject: true },
      ...operand,
    },
  };
  return { key: { route, id }, summary };
}

function indexed(
  id: string,
  operand: Pick<PublicCollectionDiscoveryOperand, 'recency' | 'popularity'> = {
    recency: ['1', route, id],
    popularity: { followers: '0' },
  },
): CollectionDiscoveryItem {
  return {
    key: { route, id },
    status: 'indexable',
    value: {
      kind: 'collection',
      key: { route, id },
      revision: 1,
      title: id,
      description: null,
      presentationKind: null,
      coverMediaId: null,
      operands: {
        presentationKind: { kind: 'mixed' },
        subjectMembership: null,
        popularity: operand.popularity,
        recency: operand.recency,
      },
      membershipKind: 'curated',
      output: null,
    },
  };
}

function source(items: CollectionDiscoveryItem[], pageLimit = 100): CollectionDiscoverySource {
  const ordered = [...items].sort(
    (left, right) =>
      left.key.route - right.key.route || (left.key.id < right.key.id ? -1 : left.key.id > right.key.id ? 1 : 0),
  );
  return {
    async read(_partition, keys) {
      const byId = new Map(ordered.map((item) => [item.key.id, item]));
      return {
        status: 'available',
        stamp,
        items: keys.map((key) => byId.get(key.id) ?? { key, status: 'withdrawn' as const }),
      };
    },
    async page(_partition, after, limit) {
      const bound = Math.min(limit, pageLimit);
      const start = after ? ordered.findIndex((item) => item.key.id === after.id) + 1 : 0;
      const page = ordered.slice(start, start + bound);
      return {
        status: 'available',
        stamp,
        items: page,
        next: page.length === bound && page.length ? page.at(-1)!.key : null,
      };
    },
    async count() {
      return { status: 'unavailable', reason: 'native_collection_population_evidence_unavailable' };
    },
  };
}

function registry(collection: 'ready' | 'unavailable') {
  return createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source: { read: unused, count: unused },
      hydrate: unused,
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: { read: unused, count: unused, page: unused },
      hydrate: unused,
      labels: { en: 'Accounts' },
      icon: 'account',
    },
    ownerAdapters: {
      collection:
        collection === 'unavailable'
          ? { readiness: 'unavailable' }
          : {
              readiness: 'ready',
              adapter: {
                owner: 'commerce',
                kind: 'collection',
                metadata: { id: 'collection', labels: { en: 'Collections' }, icon: 'collection' },
                async readCurrent(ids) {
                  return new Map(
                    ids.map((id) => [id, row(id, { recency: ['1', route, id], popularity: null }).summary]),
                  );
                },
              },
            },
      review: { readiness: 'unavailable' },
      space: { readiness: 'unavailable' },
    },
  });
}

test('directory query maps mixed/kind, curator, contained subject and recent/popular order', () => {
  expect(collectionDirectoryQuery({ order: 'recent' })).toEqual({ order: 'recency' });
  expect(
    collectionDirectoryQuery({
      presentationKind: 'mixed',
      curator: older,
      subject: newer,
      order: 'popular',
    }),
  ).toEqual({
    presentationKind: { kind: 'mixed' },
    curatorAccountId: older,
    subjectId: newer,
    popularity: true,
    order: 'popularity',
  });
  expect(collectionDirectoryQuery({ presentationKind: 'schema:Book', order: 'recent' })).toEqual({
    presentationKind: { kind: 'owner', id: 'schema:Book' },
    order: 'recency',
  });
  expect(collectionDirectoryOrder({ order: 'popular' })).toBe('popularity');
});

test('recency is newest first with nulls last, popularity descending, and identity ties are total', () => {
  const nullRecency = row(older, { recency: [null, route, older], popularity: { followers: '9' } });
  const early = row(newer, { recency: ['100', route, newer], popularity: { followers: '2' } });
  const late = row(popular, { recency: ['200', route, popular], popularity: { followers: '2' } });
  expect(sortCollectionDirectory([nullRecency, early, late], 'recency').map((item) => item.key.id)).toEqual([
    popular,
    newer,
    older,
  ]);
  expect(sortCollectionDirectory([early, late, nullRecency], 'popularity').map((item) => item.key.id)).toEqual([
    older,
    newer,
    popular,
  ]);
});

test('directory pages the complete frontier so newly eligible identities sort globally', () => {
  const first = row(older, { recency: ['300', route, older], popularity: { followers: '1' } });
  const second = row(newer, { recency: ['200', route, newer], popularity: { followers: '1' } });
  const third = row(popular, { recency: ['100', route, popular], popularity: { followers: '1' } });
  const ordered = sortCollectionDirectory([third, first, second], 'recency');
  const page = pageCollectionDirectory(ordered, 'recency', [], 2);
  expect(page.items.map((item) => item.key.id)).toEqual([older, newer]);
  expect(parseCollectionDirectoryAfter(page.nextAfter!)).toEqual({ sortKey: '200', route, id: newer });
  const next = pageCollectionDirectory(ordered, 'recency', page.nextAfter!, 2);
  expect(next.items.map((item) => item.key.id)).toEqual([popular]);
  expect(next.nextAfter).toBeNull();
  const extra = row(inserted, {
    recency: ['250', route, inserted],
    popularity: { followers: '1' },
  });
  const refreshed = pageCollectionDirectory(sortCollectionDirectory([...ordered, extra], 'recency'), 'recency', [], 2);
  expect(refreshed.items.map((item) => item.key.id)).toEqual([older, inserted]);
});

test('public directory hits project the current card without operands or query observation', () => {
  const item = row(older, { recency: ['1', route, older], popularity: null });
  expect(collectionDirectoryRows(new Map([[older, item.summary]]))).toEqual([item]);
  expect(projectCollectionDirectoryHit(item)).toEqual({
    key: { owner: 'library', kind: 'collection', route, id: older },
    summary: {
      kind: 'collection',
      value: { id: older, title: older, description: null, card: card(older) },
    },
  });
});

test('directory capability is present only on a ready Collection adapter', () => {
  expect(hasCollectionDirectoryCapability(registry('ready'))).toBe(true);
  expect(hasCollectionDirectoryCapability(registry('unavailable'))).toBe(false);
});

test('directory capability absent returns index_not_ready before enumeration', async () => {
  const cost = {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
  const queried = {
    consumer: {
      physicalTarget: 'discovery-unit',
      incarnation: 'incarnation',
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: 'meaning',
      readDefinition: 'definition',
    },
    snapshot: { kind: 'prepared' as const, observation: 'observation', build: 'build', generation: 1n },
  };
  const operations: PublicDiscoveryConsumerOperations = {
    capture: unused,
    captureDiscovery: unused,
    query: unused,
    queryDiscovery: unused,
    repairStep: unused,
    readStatus: unused,
    close: unused,
    async closeObservation() {},
  };
  installPublicFilterCoveragePage(operations, () => ({
    async capture() {
      throw new Error('Directory capability must refuse before capture');
    },
    query: unused,
    queryDiscovery: unused,
    async consume() {},
    async finish() {},
    async dispose() {},
    failure() {
      return { status: 'unavailable', reason: 'observation_lost', cost };
    },
  }));
  const search = createDiscoverySearch({
    consumer: operations,
    source: new Proxy({} as PublicFilterSource, {
      get() {
        throw new Error('Unexpected Source read');
      },
    }),
    keys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) },
    resolve: async () => ({ registry: registry('unavailable'), release: bundledRelease, digest: 'release' }),
    now: Date.now,
    asOf: async () => '2026-11-02T00:00:00.000Z',
  });
  await expect(
    search(
      'anonymous',
      {
        representation: 'discovery-v1',
        filter: { and: [{ kind: { in: ['collection'] } }] },
        collectionDirectory: { order: 'recent' },
        limit: 2,
      },
      {
        access: new Proxy({} as Access, {
          get() {
            throw new Error('Unexpected Access read');
          },
        }),
        actor: { kind: 'anonymous' },
        deadline: Date.now() + 30_000,
      },
    ),
  ).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(queried.consumer.physicalTarget).toBe('discovery-unit');
});

test('native complete pages walk a tail beyond the first owner batch and stay identity-ordered', async () => {
  const items = [indexed(older), indexed(newer), indexed(popular), indexed(inserted)];
  const frontier = await consumeCollectionDirectoryFrontier({
    source: source(items, 2),
    partitions: [partition],
    query: { order: 'recency' },
    deadline: Date.now() + 30_000,
    scanBound: 16,
  });
  expect(frontier.exhausted).toBe(true);
  expect(frontier.examined).toBe(4);
  expect(frontier.identities).toEqual([older, newer, popular, inserted]);
  expect(collectionDirectoryPartitions(frontier.identities)).toEqual([partition]);
  const tail = Array.from({ length: COLLECTION_DISCOVERY_BATCH_SIZE + 1 }, (_, index) =>
    indexed(`018f0000-0000-7000-8000-00a000000${String(index + 1).padStart(3, '0')}`),
  );
  const walked = await consumeCollectionDirectoryFrontier({
    source: source(tail, COLLECTION_DISCOVERY_BATCH_SIZE),
    partitions: [partition],
    query: { order: 'recency' },
    deadline: Date.now() + 30_000,
    scanBound: COLLECTION_DIRECTORY_SCAN_BOUND,
  });
  expect(walked.exhausted).toBe(true);
  expect(walked.examined).toBe(COLLECTION_DISCOVERY_BATCH_SIZE + 1);
  expect(walked.identities).toEqual(tail.map((item) => item.key.id));
});

test('an over-bound native frontier stays readiness rather than a partial listing', async () => {
  const items = [indexed(older), indexed(newer), indexed(popular)];
  await expect(
    consumeCollectionDirectoryFrontier({
      source: source(items, 2),
      partitions: [partition],
      query: { order: 'recency' },
      deadline: Date.now() + 30_000,
      scanBound: 2,
    }),
  ).rejects.toBeInstanceOf(CollectionDiscoveryReadinessError);
});

test('directory revalidates occupancy in owner batches of 100 so a tail past the first batch stays admitted', async () => {
  const identities = Array.from(
    { length: COLLECTION_DISCOVERY_BATCH_SIZE + 1 },
    (_, index) => `018f0000-0000-7000-8000-00a000000${String(index + 1).padStart(3, '0')}`,
  );
  const context: DiscoveryReadContext = {
    access: new Proxy({} as Access, {
      get() {
        throw new Error('Unexpected Access read');
      },
    }),
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  };
  const sizes: number[] = [];
  const page = await executeCollectionDirectory({
    identities,
    async readCurrent(ids) {
      return new Map(
        ids.map((id) => [id, row(id, { recency: ['1', route, id], popularity: { followers: '1' } }).summary]),
      );
    },
    async revalidate(current) {
      sizes.push(current.size);
      return current;
    },
    selection: { order: 'recent' },
    context,
    after: [],
    limit: 2,
  });
  expect(sizes).toEqual([COLLECTION_DISCOVERY_BATCH_SIZE, 1]);
  expect(page.items).toHaveLength(2);
  expect(page.exhausted).toBe(false);
});

test('executeCollectionDirectory hydrates, orders by recency and resumes a sort-keyset cursor', async () => {
  const summaries = new Map(
    [
      row(older, { recency: ['100', route, older], popularity: { followers: '1' } }),
      row(newer, { recency: ['300', route, newer], popularity: { followers: '1' } }),
      row(popular, { recency: ['200', route, popular], popularity: { followers: '9' } }),
    ].map((item) => [item.key.id, item.summary] as const),
  );
  const context: DiscoveryReadContext = {
    access: new Proxy({} as Access, {
      get() {
        throw new Error('Unexpected Access read');
      },
    }),
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  };
  const first = await executeCollectionDirectory({
    identities: [older, newer, popular],
    async readCurrent(ids) {
      return new Map(ids.flatMap((id) => (summaries.has(id) ? [[id, summaries.get(id)!] as const] : [])));
    },
    async revalidate(current) {
      return current;
    },
    selection: { order: 'recent' },
    context,
    after: [],
    limit: 2,
  });
  expect(first.items.map((item) => item.key.id)).toEqual([newer, popular]);
  expect(first.exhausted).toBe(false);
  const resumed = await executeCollectionDirectory({
    identities: [older, newer, popular],
    async readCurrent(ids) {
      return new Map(ids.flatMap((id) => (summaries.has(id) ? [[id, summaries.get(id)!] as const] : [])));
    },
    async revalidate(current) {
      return current;
    },
    selection: { order: 'recent' },
    context,
    after: first.nextAfter!,
    limit: 2,
  });
  expect(resumed.items.map((item) => item.key.id)).toEqual([older]);
  expect(resumed.nextAfter).toBeNull();
});

test('popularity order, owner removal and a currentness change are query-wide', async () => {
  const context: DiscoveryReadContext = {
    access: new Proxy({} as Access, {
      get() {
        throw new Error('Unexpected Access read');
      },
    }),
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  };
  const live = new Map(
    [
      row(older, { recency: ['10', route, older], popularity: { followers: '2' } }),
      row(newer, { recency: ['20', route, newer], popularity: { followers: '8' } }),
      row(popular, { recency: ['30', route, popular], popularity: { followers: '8' } }),
    ].map((item) => [item.key.id, item.summary] as const),
  );
  const popularPage = await executeCollectionDirectory({
    identities: [older, newer, popular],
    async readCurrent(ids) {
      return new Map(ids.flatMap((id) => (live.has(id) ? [[id, live.get(id)!] as const] : [])));
    },
    async revalidate(current) {
      return current;
    },
    selection: { order: 'popular' },
    context,
    after: [],
    limit: 10,
  });
  expect(popularPage.items.map((item) => item.key.id)).toEqual([newer, popular, older]);
  live.delete(popular);
  const removed = await executeCollectionDirectory({
    identities: [older, newer, popular],
    async readCurrent(ids) {
      return new Map(ids.flatMap((id) => (live.has(id) ? [[id, live.get(id)!] as const] : [])));
    },
    async revalidate(current) {
      return current;
    },
    selection: { order: 'popular' },
    context,
    after: [],
    limit: 10,
  });
  expect(removed.items.map((item) => item.key.id)).toEqual([newer, older]);
  await expect(
    executeCollectionDirectory({
      identities: [older],
      async readCurrent(ids) {
        return new Map(ids.map((id) => [id, live.get(id)!]));
      },
      async revalidate() {
        throw new CollectionDiscoveryReadinessError('unavailable', 'current_source_changed');
      },
      selection: { order: 'recent' },
      context,
      after: [],
      limit: 1,
    }),
  ).rejects.toMatchObject({ reason: 'current_source_changed' });
  const withheld = row(older, { recency: ['40', route, older], popularity: { followers: '9' } });
  const filtered = await executeCollectionDirectory({
    identities: [older, newer],
    async readCurrent() {
      return new Map([
        [
          older,
          {
            ...withheld.summary,
            operands: {
              ...withheld.summary.operands,
              eligible: { presentationKind: true, curator: false, subject: true },
            },
          },
        ],
        [newer, live.get(newer)!],
      ]);
    },
    async revalidate(current) {
      return current;
    },
    selection: { order: 'popular', curator: older },
    context,
    after: [],
    limit: 10,
  });
  expect(filtered.items.map((item) => item.key.id)).toEqual([newer]);
});
