import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { DiscoveryFilterDocument } from '@rezics/filter';
import { compileDiscoveryCapture } from '../../src/search/discovery-filter.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { admitDiscoveryRequest } from '../../src/search/discovery-request.ts';
import {
  admitTaggedWorkPlan,
  taggedWorkCaptureSize,
  taggedWorkCatalogueFilter,
  taggedWorkCountFilter,
  taggedWorkHitScanBound,
  taggedWorkKindTypeFilter,
  taggedWorkRemainingHasConcept,
} from '../../src/search/tagged-work-plan.ts';

const concept = '00000000-0000-4000-8000-000000000041';
const scheme = '00000000-0000-4000-8000-000000000042';
const kinds = new Set(['schema:Book', 'schema:Movie', 'schema:Person']);
const conceptLeaf = {
  statement: {
    property: 'schema:genre',
    in: [concept],
    concept: { scheme },
    qualifiers: [{ property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } }],
  },
};
const words = { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' as const } } };
const filter: DiscoveryFilterDocument = {
  and: [{ and: [conceptLeaf, words] }, { kind: { in: ['schema:Book'] } }],
};

const noRead = async (): Promise<never> => {
  throw new Error('Tagged-work admission must not read a producer');
};
const registry = createDiscoveryRegistry({
  release: bundledRelease,
  semantic: {
    source: { read: noRead, count: noRead },
    hydrate: noRead,
    icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: noRead, count: noRead, page: noRead },
    hydrate: noRead,
    labels: { en: 'Accounts' },
    icon: 'account',
  },
});

test('a designated kind leaf binds remaining catalogue predicate, native source and name order', () => {
  const plan = admitTaggedWorkPlan({
    filter,
    kindCountLeaf: 1,
    sort: 'name',
    limit: 24,
    registeredKinds: kinds,
  });
  expect(plan.kindLeaf).toEqual({ kind: { in: ['schema:Book'] } });
  expect(plan.selectedKinds).toEqual(['schema:Book']);
  expect(taggedWorkCountFilter(plan)).toEqual({ and: [conceptLeaf, words] });
  expect(taggedWorkCatalogueFilter(plan)).toEqual({ and: [conceptLeaf, words] });
  expect(plan.source).toBe('native-catalogue');
  expect(plan.execution).toBe('direct');
  expect(plan.sort).toBe('name');
  expect(plan.scanBound).toBe(Math.min(600, 6 * 24 + 3));
  expect(plan.conceptSelections).toEqual([
    {
      property: 'schema:genre',
      concept,
      scheme,
      includeChildren: false,
      qualifiers: [{ property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } }],
    },
  ]);
  expect(plan.quantityLeaves).toEqual([
    { property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' }, onConceptStatement: true },
    { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' }, onConceptStatement: false },
  ]);
  expect(plan.overflowProperties).toEqual(['schema:genre', 'rezics:sourceTagWeight', 'schema:wordCount']);
  expect(
    compileDiscoveryCapture(
      {
        representation: 'discovery-v1',
        comparator: 'mixed-public-v1',
        filterDocument: filter,
        text: undefined,
        sort: 'name',
        size: 49,
        pageSize: 24,
      },
      registry,
      bundledRelease,
    ).overflowProperties,
  ).toEqual(plan.overflowProperties);
});

test('descendant concept closures use retained membership; rating order stays finite preparation', () => {
  const descendants: DiscoveryFilterDocument = {
    and: [
      {
        statement: {
          property: 'schema:genre',
          in: [concept],
          concept: { scheme, includeChildren: true },
        },
      },
      { kind: { in: ['schema:Book', 'schema:Movie'] } },
    ],
  };
  const plan = admitTaggedWorkPlan({
    filter: descendants,
    kindCountLeaf: 1,
    sort: 'rating',
    limit: 24,
    registeredKinds: kinds,
  });
  expect(plan.source).toBe('concept-retained');
  expect(plan.execution).toBe('preparing');
  expect(plan.sort).toBe('rating');
  expect(plan.conceptSelections[0]?.includeChildren).toBe(true);
  expect(taggedWorkRemainingHasConcept(descendants, 1)).toBe(true);
  expect(taggedWorkRemainingHasConcept(filter, 0)).toBe(false);
});

test('mixed discovery still refuses rating without a concept remaining predicate', () => {
  const mixed = {
    representation: 'discovery-v1' as const,
    filter: { and: [{ kind: { in: ['account', 'schema:Person'] } }, { not: { type: { in: ['schema:Book'] } } }] },
    sort: 'rating' as const,
    languages: ['en'],
    kindCountLeaf: 0,
  };
  expect(() => admitDiscoveryRequest(mixed, registry, bundledRelease)).toThrow();
});

test('tagged-work discovery admits rating when the remaining conjunct is a concept statement', () => {
  const admitted = admitDiscoveryRequest(
    {
      representation: 'discovery-v1',
      filter,
      sort: 'rating',
      languages: ['en'],
      kindCountLeaf: 1,
    },
    registry,
    bundledRelease,
  );
  expect(admitted.sort).toBe('rating');
  expect(admitted.kindCountLeaf).toBe(1);
  expect(admitted.countFilter).toEqual({ and: [conceptLeaf, words] });
});

test('direct name order admits a finite capture window and designated kind as a type leaf', () => {
  const plan = admitTaggedWorkPlan({
    filter,
    kindCountLeaf: 1,
    sort: 'id',
    limit: 24,
    registeredKinds: kinds,
  });
  expect(plan.sort).toBe('id');
  expect(plan.execution).toBe('direct');
  expect(taggedWorkKindTypeFilter(plan)).toEqual({ type: { in: ['schema:Book'] } });
  expect(taggedWorkCaptureSize(plan)).toBe(Math.min(200, plan.scanBound));
  expect(taggedWorkHitScanBound(plan, 24)).toBe(plan.scanBound);
  expect(taggedWorkHitScanBound(undefined, 24)).toBe(Math.min(600, 6 * 24 + 3));
});
