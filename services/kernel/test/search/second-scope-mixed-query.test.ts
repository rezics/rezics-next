import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { compileDiscoveryFilter, currentDiscoveryFilter } from '../../src/search/discovery-filter.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import { admitDiscoveryHit } from '../../src/search/discovery-http.ts';
import { discoveryKindDirectory } from '../../src/search/discovery-registry.ts';
import { compareDiscoveryTuple, type DiscoveryCandidate } from '../../src/search/discovery-query.ts';
import { routeOf } from '../../src/route/route.ts';
import type { DiscoveryKey, DiscoveryOwnerRegistry, DiscoveryReadContext, DiscoveryRegistry } from '../../src/search/discovery.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const entries = [
  { owner: 'semantic', kind: 'schema:Person' },
  { owner: 'content', kind: 'collection', domains: ['text', 'kind'] },
] as unknown as DiscoveryRegistry['entries'];
const registry = {
  entries,
  get: (kind: string) => entries.find((entry) => entry.kind === kind)!,
  key: (key: DiscoveryKey) => key,
} as unknown as DiscoveryRegistry;

test('Subject-only NOT stays in its domain and an unready metadata owner cannot become an empty success', async () => {
  const subjectType = { type: { in: ['schema:Person'] } };
  const notSubjectType = { not: subjectType };
  expect(currentDiscoveryFilter(subjectType, registry, 'collection', bundledRelease)).toBe(false);
  expect(currentDiscoveryFilter(notSubjectType, registry, 'collection', bundledRelease)).toBe(false);
  expect(
    currentDiscoveryFilter(
      { or: [notSubjectType, { kind: { in: ['collection'] } }] },
      registry,
      'collection',
      bundledRelease,
    ),
  ).toBe(true);
  expect(JSON.stringify(compileDiscoveryFilter(notSubjectType, registry, bundledRelease).query)).toContain(
    '"owner":"semantic"',
  );
  const candidate = { key: { owner: 'content', kind: 'collection', route: 160, id } } as unknown as DiscoveryCandidate;
  await expect(
    currentDiscoveryCandidates(registry, [candidate], notSubjectType, bundledRelease, {} as DiscoveryReadContext),
  ).rejects.toThrow('Current discovery owner evidence is unavailable');
  expect(
    compareDiscoveryTuple([id, 'collection', 'collection:uuid'], [id, 'review', 'thread:uuid'], 'id'),
  ).toBeLessThan(0);
});

test('ready owner kinds enter the directory and their public variants pass the closed wire admission', () => {
  const kind = (id: string) => ({ id, labels: { en: id }, icon: id });
  const owner = (id: 'collection' | 'review' | 'space', ownerName: 'commerce' | 'content') => ({
    readiness: 'ready',
    adapter: { kind: id, owner: ownerName, metadata: kind(id), readCurrent: async () => new Map() },
  });
  const readyRegistry = {
    entries: [
      { owner: 'semantic', kind: 'schema:Person', domains: ['text', 'kind'], metadata: kind('schema:Person') },
      { owner: 'accounts', kind: 'account', domains: ['text', 'kind'], metadata: kind('account') },
    ],
    ownerAdapters: {
      collection: owner('collection', 'commerce'),
      review: owner('review', 'content'),
      space: owner('space', 'content'),
    },
  } as unknown as DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>;
  expect(discoveryKindDirectory(readyRegistry).map(({ kind: value }) => value)).toEqual([
    'account',
    'collection',
    'review',
    'schema:Person',
    'space',
  ]);
  const route = routeOf(id)!;
  for (const hit of [
    {
      key: { owner: 'library', kind: 'collection', route, id },
      summary: { kind: 'collection', value: { id, title: 'Library', description: null } },
    },
    {
      key: { owner: 'content', kind: 'review', route, id },
      summary: { kind: 'review', value: { id, kind: 'review', title: null, excerpt: '😀'.repeat(320) } },
    },
    {
      key: { owner: 'community', kind: 'space', route, id },
      summary: { kind: 'space', value: { id, title: 'A place', address: 'place' } },
    },
  ])
    expect(() => admitDiscoveryHit(hit)).not.toThrow();
});
