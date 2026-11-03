import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import release from '../../../../packages/definitions/release/rezics.json';
import {
  discoveryBulkBody,
  mixedDiscoveryIndexDefinition,
  parseDiscoveryDocumentKey,
  parseDiscoveryHitKey,
  secondScopeDiscoveryDocumentActions,
  validateDiscoveryDocumentFormat,
  type SecondScopeDiscoveryKey,
  type SecondScopeDiscoveryObservation,
} from '../../src/search/discovery-documents.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import type { DiscoveryRegistryOptions } from '../../src/search/discovery.ts';

const nativeId = '018f0000-0000-7000-8000-00a000000001';
const route = 160;
const partition = 10;
const position = 9_007_199_254_740_997n;
const revision = 9_007_199_254_740_995n;
const noRead = async (): Promise<never> => {
  throw new Error('Document construction must not call a source or hydrate profiles');
};
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
};
const registry = createDiscoveryRegistry(options);
const collectionKey: SecondScopeDiscoveryKey = { owner: 'commerce', kind: 'collection', route, id: nativeId };
const reviewKey: SecondScopeDiscoveryKey = { owner: 'content', kind: 'review', route, id: nativeId };
const spaceKey: SecondScopeDiscoveryKey = { owner: 'content', kind: 'space', route, id: nativeId };
const collectionObservation: SecondScopeDiscoveryObservation = {
  owner: 'commerce',
  snapshot: {
    partition,
    position,
    complete: true,
    records: [
      {
        key: collectionKey,
        revision,
        names: ['Public Collection'],
        descriptions: [],
        nameSort: 'public collection',
      },
    ],
  },
};
const contentObservation: SecondScopeDiscoveryObservation = {
  owner: 'content',
  snapshot: {
    partition,
    position,
    complete: true,
    records: [
      { key: reviewKey, revision, names: ['Public review'], descriptions: ['Public thread text'], nameSort: 'review' },
      { key: spaceKey, revision, names: ['Public Space'], descriptions: ['Public summary'], nameSort: 'space' },
    ],
  },
};

test('Collection, review and Space snapshots share format 2 with exact native keys and versions', () => {
  const collectionActions = secondScopeDiscoveryDocumentActions(registry, collectionObservation, [collectionKey]);
  const contentActions = secondScopeDiscoveryDocumentActions(registry, contentObservation, [spaceKey, reviewKey]);
  expect(collectionActions[0]).toMatchObject({
    op: 'index',
    id: 'discovery-v1:collection:018f0000-0000-7000-8000-00a000000001',
    version: position,
  });
  expect(contentActions.map((action) => action.id)).toEqual([
    'discovery-v1:space:018f0000-0000-7000-8000-00a000000001',
    'discovery-v1:review:018f0000-0000-7000-8000-00a000000001',
  ]);
  const review = contentActions[1]!;
  if (review.op !== 'index') throw new Error('Expected a review document');
  expect(review.document).toEqual({
    document_format: 2,
    identity: review.id,
    owner: 'content',
    kind: 'review',
    id: nativeId,
    route,
    partition,
    source_position: position.toString(),
    revision: revision.toString(),
    names: ['Public review'],
    descriptions: ['Public thread text'],
    name_sort: 'review',
  });
  expect(parseDiscoveryDocumentKey(registry, review.id)).toEqual(reviewKey);
  expect(parseDiscoveryHitKey(registry, { _id: review.id, _source: review.document })).toEqual(reviewKey);

  const body = discoveryBulkBody(registry, 'search-discovery-g1', [review]);
  expect(body).toContain(`"version":${position.toString()}`);
  expect(JSON.parse(body.trim().split('\n')[1]!).source_position).toBe(position.toString());

  const mapping = mixedDiscoveryIndexDefinition().mappings;
  expect(mapping.dynamic).toBe('strict');
  for (const action of [...collectionActions, ...contentActions]) {
    if (action.op !== 'index') continue;
    for (const field of Object.keys(action.document)) expect(mapping.properties).toHaveProperty(field);
  }
  expect((mapping._meta as unknown as Record<string, unknown>).second_scope_kinds).toEqual({
    collection: 'commerce',
    review: 'content',
    space: 'content',
  });
});

test('incomplete, foreign and expanded documents fail before indexing or hit disclosure', () => {
  expect(() =>
    secondScopeDiscoveryDocumentActions(
      registry,
      { ...contentObservation, snapshot: { ...contentObservation.snapshot, complete: false } },
      [reviewKey],
    ),
  ).toThrow();
  expect(() =>
    secondScopeDiscoveryDocumentActions(registry, collectionObservation, [
      { ...reviewKey, owner: 'commerce' } as unknown as SecondScopeDiscoveryKey,
    ]),
  ).toThrow();
  expect(() =>
    parseDiscoveryDocumentKey(registry, 'discovery-v1:%73pace:018f0000-0000-7000-8000-00a000000001'),
  ).toThrow();
  expect(() => parseDiscoveryDocumentKey(registry, 'discovery-v1:space:not-a-native-id')).toThrow();

  const [spaceAction] = secondScopeDiscoveryDocumentActions(registry, contentObservation, [spaceKey]);
  if (!spaceAction || spaceAction.op !== 'index') throw new Error('Expected a Space document');
  const privateField = { ...spaceAction.document, realmVotes: [{ voter: nativeId, score: 5 }] };
  expect(() => validateDiscoveryDocumentFormat(registry, privateField)).toThrow();
  expect(() => parseDiscoveryHitKey(registry, { _id: spaceAction.id, _source: privateField })).toThrow();
  expect(() => validateDiscoveryDocumentFormat(registry, { ...spaceAction.document, document_format: 1 })).toThrow();
  expect(() => validateDiscoveryDocumentFormat(registry, { ...spaceAction.document, owner: 'commerce' })).toThrow();
});
