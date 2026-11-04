import { expect, test } from 'bun:test';
import type { AccountDiscoverySummary } from '../../src/search/discovery.ts';
import { routeOf } from '../../src/route/route.ts';
import type { FeedItem } from '../../src/content/feed-contract.ts';
import {
  finalizeFeedPublicOwnerContext,
  prepareFeedPublicOwnerContext,
  retainFeedCollectionCurator,
} from '../../src/content/feed-public-owner-context.ts';

const collectionId = '00000000-0000-7000-8000-000000000101';
const collectionRoute = routeOf(collectionId)!;
const curatorId = '00000000-0000-7000-8000-000000000102';
const foreignId = '00000000-0000-7000-8000-000000000103';

function discoveryCollection(): Extract<FeedItem, { source: 'discovery'; destination: { kind: 'collection' } }> {
  return {
    id: 'discovery:commerce:collection',
    source: 'discovery',
    occurredAt: null,
    key: { owner: 'commerce', kind: 'collection', route: collectionRoute, id: collectionId },
    summary: {
      id: collectionId,
      title: 'Reading shelf',
      description: '',
      curator: { state: 'available', id: foreignId, label: 'Search curator', destination: '/@search' },
      presentationKind: null,
      presentationKindSource: 'empty',
      cover: null,
      coverSource: 'none',
    },
    destination: { kind: 'collection', id: collectionId, title: 'Reading shelf' },
  };
}

function followingCollection(
  occurrence: string,
  description: string | null = null,
  ownerId: string | null = curatorId,
): Extract<FeedItem, { source: 'following'; destination: { kind: 'collection' } }> {
  const item = {
    id: occurrence,
    source: 'following',
    occurredAt: '2026-11-04T00:00:00Z',
    key: { owner: 'library', kind: 'collection', route: collectionRoute, id: collectionId },
    summary: {
      id: collectionId,
      title: 'Reading shelf',
      description,
      curator: { state: 'unavailable', reason: 'native_projection' },
      presentationKind: null,
      presentationKindSource: 'empty',
      cover: null,
      coverSource: 'none',
    },
    destination: { kind: 'collection', id: collectionId, title: 'Reading shelf' },
  } satisfies Extract<FeedItem, { source: 'following'; destination: { kind: 'collection' } }>;
  return retainFeedCollectionCurator(item, ownerId);
}

const curator: AccountDiscoverySummary = {
  id: curatorId,
  accountKind: 'actor',
  handle: 'mira',
  displayName: 'Mira Chen',
  automated: false,
  operatorId: null,
  avatar: null,
  verifiedAgent: null,
};

test('public Collection context keeps source coverage and duplicate occurrences through one bounded identity read and final admission', async () => {
  const discovery = discoveryCollection();
  const first = followingCollection('following:one', '');
  const second = followingCollection('following:two');
  const items = [discovery, first, second];
  const calls: string[][] = [];
  const order: string[] = [];
  const result = await finalizeFeedPublicOwnerContext(
    items,
    async (ids) => {
      order.push('accounts');
      calls.push([...ids]);
      return new Map([[curatorId, curator]]);
    },
    async () => {
      order.push('final-admission');
      return items;
    },
  );

  expect(order).toEqual(['accounts', 'final-admission']);
  expect(calls).toEqual([[curatorId]]);
  expect(result.coverage).toEqual({ discovery: 1, following: 2 });
  expect(result.items).toEqual(items);
  expect(result.curators.get(discovery)).toEqual(discovery.summary.curator);
  expect(result.curators.get(first)).toEqual({
    state: 'available',
    id: curatorId,
    label: 'Mira Chen',
    destination: '/@mira',
  });
  expect(result.curators.has(first)).toBe(true);
  expect(result.curators.has(second)).toBe(true);
  expect(first.summary.description).toBe('');
  expect(second.summary.description).toBeNull();
});

test('curator projection failure stays unavailable without rejecting the admitted Collection occurrence', async () => {
  const item = followingCollection('following:one');
  const order: string[] = [];
  const result = await finalizeFeedPublicOwnerContext(
    [item],
    async () => {
      order.push('accounts');
      throw new Error('Accounts projection unavailable');
    },
    async () => {
      order.push('final-admission');
      return [item];
    },
  );

  expect(order).toEqual(['accounts', 'final-admission']);
  expect(result.items).toEqual([item]);
  expect(item.summary.curator).toEqual({ state: 'unavailable', reason: 'native_projection' });
});

test('a deidentified Collection curator stays explicit and does not select an Account', async () => {
  const item = followingCollection('following:anonymous', null, null);
  const reads: string[][] = [];
  const context = await prepareFeedPublicOwnerContext([item], async (ids) => {
    reads.push([...ids]);
    return new Map();
  });

  expect(context.coverage).toEqual({ discovery: 0, following: 1 });
  expect(context.curators.get(item)).toEqual({ state: 'unavailable', reason: 'deidentified' });
  expect(reads).toEqual([]);
});

test('mismatched owner destinations do not select a curator and selected context stays within the page bound', async () => {
  const wrongItem = {
    ...followingCollection('following:wrong'),
    destination: { kind: 'collection', id: foreignId, title: 'Replacement' },
  } satisfies Extract<FeedItem, { source: 'following'; destination: { kind: 'collection' } }>;
  const wrong = retainFeedCollectionCurator(wrongItem, curatorId);
  const calls: string[][] = [];
  const ignored = await prepareFeedPublicOwnerContext([wrong], async (ids) => {
    calls.push([...ids]);
    return new Map([[curatorId, curator]]);
  });
  expect(ignored.coverage).toEqual({ discovery: 0, following: 0 });
  expect(ignored.curators.size).toBe(0);
  expect(calls).toEqual([]);

  const oversized = Array.from({ length: 21 }, (_, index) => followingCollection(`following:${index}`));
  await expect(prepareFeedPublicOwnerContext(oversized, async () => new Map())).rejects.toThrow(
    'Feed public-owner context exceeds the selected page bound',
  );
  expect(calls).toEqual([]);
});
