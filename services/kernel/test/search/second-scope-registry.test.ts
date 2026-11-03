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
function currentSummaries(ids: readonly string[], title: string) {
  return new Map(ids.map((currentId) => [currentId, { id: currentId, title, summary: null }] as const));
}
const options: DiscoveryRegistryOptions = {
  release: release as Release,
  semantic: {
    source: { read: noRead, count: noRead },
    hydrate: noRead,
    icons: Object.fromEntries(Object.keys(release.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: noRead, count: noRead, page: noRead },
    hydrate: noRead,
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
          return currentSummaries(ids, 'Collection');
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
          return currentSummaries(ids, 'Review');
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
          return currentSummaries(ids, 'Space');
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

test('ready owner adapters preserve canonical identity and current text/kind metadata', async () => {
  const hits = await hydrateOwnerDiscoveryHits(registry, keys, {} as DiscoveryReadContext);
  expect(hits.map(({ key }) => key)).toEqual(keys);
  expect(new Set(hits.map(({ key }) => `${key.owner}:${key.kind}:${key.route}:${key.id}`)).size).toBe(3);
  expect(hits.map(({ summary }) => summary)).toEqual([
    { kind: 'collection', value: { id, title: 'Collection', summary: null } },
    { kind: 'review', value: { id, title: 'Review', summary: null } },
    { kind: 'space', value: { id, title: 'Space', summary: null } },
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
  await expect(hydrateOwnerDiscoveryHits(unavailable, [keys[0]!], {} as DiscoveryReadContext)).rejects.toThrow();
});
