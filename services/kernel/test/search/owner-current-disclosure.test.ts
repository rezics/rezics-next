import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { PublicCollectionDiscoverySummary } from '../../src/library/index.ts';
import type { Access } from '../../src/request/access.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { hydrateOwnerDiscoveryHits, type DiscoveryOwnerCandidate } from '../../src/search/discovery-hydration.ts';
import type { DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from '../../src/search/discovery.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const route = 160;
const queryObservation = 'a'.repeat(64);
const context: DiscoveryReadContext = {
  actor: { kind: 'anonymous' },
  deadline: 1,
  access: new Proxy({} as Access, {
    get() {
      throw new Error('Owner current disclosure must not consult Access for collection rows');
    },
  }),
};
const unused = async (): Promise<never> => {
  throw new Error('Owner current disclosure must not read a catalogue producer');
};
function collectionCard(title: string, revision: number, collectionId = id): PublicCollectionDiscoverySummary {
  return {
    id: collectionId,
    title,
    description: null,
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    curator: { state: 'unavailable', reason: 'deidentified' },
    preview: { state: 'empty' },
    kind: 'collection',
    destination: `/collections/${collectionId}`,
    visibility: 'public',
    revision,
    sourceGeneration: 'generation-1',
    membershipKind: 'dynamic',
    outputGeneration: 'generation-1',
  };
}
function collection(title: string, revision: string, collectionId = id): DiscoveryOwnerMetadataSummary<'collection'> {
  return {
    id: collectionId,
    title,
    summary: null,
    revision,
    sourcePosition: '4',
    queryObservation,
    card: collectionCard(title, Number(revision), collectionId),
    operands: {
      id: collectionId,
      presentationKind: { kind: 'mixed' },
      curator: { state: 'unavailable', reason: 'deidentified' },
      subjectMembership: null,
      popularity: null,
      recency: [null, route, collectionId],
      eligible: { presentationKind: null, curator: null, subject: null },
    },
  };
}

test('a public-to-private change during nested hydration withholds the owner hit', async () => {
  const rows = [collection('Public shelf', '1')];
  let reads = 0;
  const registry = createDiscoveryRegistry({
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
      collection: {
        readiness: 'ready',
        adapter: {
          owner: 'commerce',
          kind: 'collection',
          metadata: { id: 'collection', labels: { en: 'Collections' }, icon: 'library' },
          async readCurrent(ids) {
            reads++;
            if (reads === 1) return new Map(ids.map((currentId) => [currentId, rows[0]!] as const));
            return new Map();
          },
        },
      },
      review: { readiness: 'unavailable' },
      space: { readiness: 'unavailable' },
    },
  });
  const candidates: DiscoveryOwnerCandidate[] = [
    { key: { owner: 'commerce', kind: 'collection', route, id }, revision: '1', sourcePosition: '4' },
  ];
  expect(await hydrateOwnerDiscoveryHits(registry, candidates, context)).toEqual([undefined]);
  expect(reads).toBe(2);
});

test('a full owner window keeps current cards through bounded initial and final hydration', async () => {
  const ids = Array.from(
    { length: 200 },
    (_, index) => `018f0000-0000-7000-8000-00a0${String(index + 1).padStart(8, '0')}`,
  );
  const rows = new Map(ids.map((id) => [id, collection('Public shelf', '1', id)]));
  let reads = 0;
  const registry = createDiscoveryRegistry({
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
      collection: {
        readiness: 'ready',
        adapter: {
          owner: 'commerce',
          kind: 'collection',
          metadata: { id: 'collection', labels: { en: 'Collections' }, icon: 'library' },
          async readCurrent(ids) {
            reads++;
            expect(ids.length).toBeLessThanOrEqual(100);
            return new Map(ids.map((currentId) => [currentId, rows.get(currentId)!] as const));
          },
        },
      },
      review: { readiness: 'unavailable' },
      space: { readiness: 'unavailable' },
    },
  });
  const candidates: DiscoveryOwnerCandidate[] = ids.map((id) => ({
    key: { owner: 'commerce', kind: 'collection', route, id },
    revision: '1',
    sourcePosition: '4',
  }));
  const hits = await hydrateOwnerDiscoveryHits(registry, candidates, context);
  expect(hits).toHaveLength(200);
  expect(hits.map((hit) => hit?.summary.value.id)).toEqual(ids);
  expect(hits[0]?.summary.value.id).toBe(id);
  expect(hits[0]?.summary.value.title).toBe('Public shelf');
  expect(reads).toBe(4);
});

test.each(['replacement', 'in-place'] as const)(
  'a changed owner revision (%s) during nested hydration restarts instead of publishing the stale card',
  async (mode) => {
    const rows = [collection('Public shelf', '1'), collection('Public shelf', '2')];
    let reads = 0;
    const registry = createDiscoveryRegistry({
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
        collection: {
          readiness: 'ready',
          adapter: {
            owner: 'commerce',
            kind: 'collection',
            metadata: { id: 'collection', labels: { en: 'Collections' }, icon: 'library' },
            async readCurrent(ids) {
              reads++;
              if (mode === 'in-place' && reads === 2) Object.assign(rows[0]!, rows[1]);
              return new Map(ids.map((currentId) => [currentId, rows[mode === 'in-place' ? 0 : reads - 1]!] as const));
            },
          },
        },
        review: { readiness: 'unavailable' },
        space: { readiness: 'unavailable' },
      },
    });
    const candidates: DiscoveryOwnerCandidate[] = [
      { key: { owner: 'commerce', kind: 'collection', route, id }, revision: '1', sourcePosition: '4' },
    ];
    await expect(hydrateOwnerDiscoveryHits(registry, candidates, context)).rejects.toMatchObject({
      code: 'search_restart_required',
    });
    expect(reads).toBe(2);
  },
);
