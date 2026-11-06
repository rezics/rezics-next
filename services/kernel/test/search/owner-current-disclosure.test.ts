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
function collectionCard(title: string, revision: number): PublicCollectionDiscoverySummary {
  return {
    id,
    title,
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
    revision,
    sourceGeneration: 'generation-1',
    membershipKind: 'dynamic',
    outputGeneration: 'generation-1',
  };
}
function collection(title: string, revision: string): DiscoveryOwnerMetadataSummary<'collection'> {
  return {
    id,
    title,
    summary: null,
    revision,
    sourcePosition: '4',
    queryObservation,
    card: collectionCard(title, Number(revision)),
    operands: {
      id,
      presentationKind: { kind: 'mixed' },
      curator: { state: 'unavailable', reason: 'deidentified' },
      subjectMembership: null,
      popularity: null,
      recency: [null, route, id],
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

test('unchanged owner rows after nested hydration keep the current card', async () => {
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
            return new Map(ids.map((currentId) => [currentId, rows[0]!] as const));
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
  const hits = await hydrateOwnerDiscoveryHits(registry, candidates, context);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.summary.value.id).toBe(id);
  expect(hits[0]?.summary.value.title).toBe('Public shelf');
  expect(reads).toBe(2);
});

test('a changed owner revision during nested hydration restarts instead of publishing the stale card', async () => {
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
            return new Map(ids.map((currentId) => [currentId, rows[reads - 1]!] as const));
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
});
