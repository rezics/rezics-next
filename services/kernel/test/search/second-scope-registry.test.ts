import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import release from '../../../../packages/definitions/release/rezics.json';
import { hydrateOwnerDiscoveryHits } from '../../src/search/discovery-hydration.ts';
import {
  createDiscoveryRegistry,
  discoveryDomain,
  evaluateDiscoveryCondition,
} from '../../src/search/discovery-registry.ts';
import type { DiscoveryOwnerKey, DiscoveryReadContext, DiscoveryRegistryOptions } from '../../src/search/discovery.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const route = 160;
const noRead = async (): Promise<never> => {
  throw new Error('This registry test must not read existing producer sources');
};
const options: DiscoveryRegistryOptions = {
  release: release as Release,
  semantic: {
    source: { read: noRead, count: noRead },
    hydrate: async () => new Map(),
    icons: Object.fromEntries(Object.keys(release.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: noRead, count: noRead, page: noRead },
    hydrate: async () => new Map(),
    labels: { en: 'Accounts' },
    icon: 'account',
  },
  ownerAdapters: {
    collection: {
      readiness: 'ready',
      adapter: {
        owner: 'commerce',
        kind: 'collection',
        metadata: { id: 'collection', labels: { en: 'Collections' }, icon: 'collection' },
        async readCurrent(ids) {
          return new Map(ids.map((id) => [id, {
            id, title: 'Collection', summary: null, revision: '1', sourcePosition: '1',
            card: {
              id, kind: 'collection' as const, destination: `/collections/${id}` as const,
              title: 'Collection', description: null, visibility: 'public' as const, revision: 1,
              membershipKind: 'dynamic' as const, outputGeneration: '1',
              presentationKind: 'list' as const, presentationKindSource: 'default' as const,
              cover: null, coverSource: 'none' as const,
            },
          }]));
        },
      },
    },
    review: {
      readiness: 'ready',
      adapter: {
        owner: 'content',
        kind: 'review',
        metadata: { id: 'review', labels: { en: 'Reviews' }, icon: 'review' },
        async readCurrent(ids) {
          return new Map(ids.map((id) => [id, {
            id, title: 'Review', summary: null, sourceVersion: 'v1', sourcePosition: '1',
            authorId: id, subjectId: id,
          }]));
        },
      },
    },
    space: {
      readiness: 'ready',
      adapter: {
        owner: 'content',
        kind: 'space',
        metadata: { id: 'space', labels: { en: 'Spaces' }, icon: 'space' },
        async readCurrent(ids) {
          return new Map(ids.map((id) => [id, {
            id, title: 'Space', summary: null, revision: '1', sourcePosition: '1',
            address: 'space', realmId: null, realmTitle: null,
          }]));
        },
      },
    },
  },
};
const registry = createDiscoveryRegistry(options);
const keys: DiscoveryOwnerKey[] = [
  { owner: 'commerce', kind: 'collection', route, id },
  { owner: 'content', kind: 'review', route, id },
  { owner: 'content', kind: 'space', route, id },
];
const candidates = keys.map((key) => ({ key, sourcePosition: '1', revision: '1', sourceVersion: 'v1' }));
const publicKeys = [{ ...keys[0]!, owner: 'library' }, keys[1]!, { ...keys[2]!, owner: 'community' }];

test('ready owner adapters preserve canonical identity and current text/kind metadata', async () => {
  const hits = await hydrateOwnerDiscoveryHits(registry, candidates, {} as DiscoveryReadContext);
  expect(hits.map((hit) => hit!.key)).toEqual(publicKeys);
  expect(new Set(hits.map((hit) => `${hit!.key.owner}:${hit!.key.kind}:${hit!.key.route}:${hit!.key.id}`)).size).toBe(3);
  expect(hits.map((hit) => hit!.summary)).toEqual([
    { kind: 'collection', value: { id, title: 'Collection', description: null } },
    { kind: 'review', value: { id, kind: 'review', title: 'Review' } },
    { kind: 'space', value: { id, title: 'Space', address: 'space' } },
  ]);
  for (const kind of ['collection', 'review', 'space']) {
    expect(discoveryDomain(registry, kind, 'text')).toBe('applicable');
    expect(discoveryDomain(registry, kind, 'kind')).toBe('applicable');
    expect(discoveryDomain(registry, kind, 'type')).toBe('not_applicable');
    expect(
      evaluateDiscoveryCondition(registry, kind, { not: { domain: 'type', value: 'schema:Person' } }, () => {
        throw new Error('An inapplicable Subject predicate must not be evaluated');
      }),
    ).toBe('not_applicable');
  }
});

test('unknown, foreign, and unavailable owners fail closed while legacy registrations remain', async () => {
  expect(registry.entries.map(({ kind }) => kind)).toEqual([...Object.keys(release.types), 'account']);
  expect(registry.get('schema:Person').owner).toBe('semantic');
  expect(registry.get('account').domains).toEqual(['text', 'kind']);
  expect(() => registry.ownerKey({ ...keys[1]!, owner: 'commerce' } as DiscoveryOwnerKey)).toThrow(
    'does not own this kind',
  );
  expect(() =>
    registry.ownerKey({ owner: 'content', kind: 'unknown', route, id } as unknown as DiscoveryOwnerKey),
  ).toThrow();

  const unavailable = createDiscoveryRegistry({
    ...options,
    ownerAdapters: {
      collection: { readiness: 'unavailable' },
      review: { readiness: 'unavailable' },
      space: { readiness: 'unavailable' },
    },
  });
  expect(unavailable.ownerAdapters.collection.readiness).toBe('unavailable');
  expect(() => unavailable.ownerKey(keys[0]!)).toThrow();
  expect(() => unavailable.getOwnerAdapter('collection')).toThrow();
  await expect(hydrateOwnerDiscoveryHits(unavailable, [candidates[0]!], {} as DiscoveryReadContext)).rejects.toThrow();
});
