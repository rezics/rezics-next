import { expect, test } from 'bun:test';
import { feedDiscoveryItem } from '../../src/content/feed-discovery.ts';
import type { DiscoveryUnionHit } from '../../src/search/discovery.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const collectionId = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const spaceId = '00000000-0000-4000-8000-000000000004';
const subject: DiscoveryUnionHit = {
  key: { owner: 'semantic', kind: 'schema:Book', route: 0, id: subjectId },
  summary: {
    kind: 'subject',
    value: {
      id: subjectId,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: null,
      creativeWork: true,
      cover: null,
    },
  },
};
const account: DiscoveryUnionHit = {
  key: { owner: 'accounts', kind: 'account', route: 0, id: subjectId },
  summary: {
    kind: 'account',
    value: {
      id: subjectId,
      accountKind: 'actor',
      handle: 'reader',
      displayName: null,
      automated: false,
      operatorId: null,
      avatar: null,
      verifiedAgent: null,
    },
  },
};
const collection: DiscoveryUnionHit = {
  key: { owner: 'library', kind: 'collection', route: 0, id: collectionId },
  summary: { kind: 'collection', value: { id: collectionId, title: 'Reading shelf', description: 'Short novels.' } },
};
const review: DiscoveryUnionHit = {
  key: { owner: 'content', kind: 'review', route: 0, id: reviewId },
  summary: {
    kind: 'review',
    value: {
      id: reviewId,
      kind: 'review',
      title: 'A careful reread',
      author: { displayName: 'Current Reader', handle: 'reader' },
      excerpt: 'The opening holds.',
      subject: { id: subjectId, title: 'The Little Prince' },
    },
  },
};
const space: DiscoveryUnionHit = {
  key: { owner: 'community', kind: 'space', route: 0, id: spaceId },
  summary: {
    kind: 'space',
    value: {
      id: spaceId,
      title: 'Quiet room',
      address: 'quiet-room',
      summary: 'A quiet reading room.',
      realm: { id: '00000000-0000-4000-8000-000000000005', title: 'Atlas Realm' },
    },
  },
};

test('native public summaries map to closed feed identities and canonical destinations without reads', () => {
  const items = [subject, account, collection, review, space].map(feedDiscoveryItem);
  expect(items.map((item) => item.key)).toEqual([
    subject.key,
    account.key,
    { owner: 'commerce', kind: 'collection', route: 0, id: collectionId },
    review.key,
    { owner: 'content', kind: 'space', route: 0, id: spaceId },
  ]);
  expect(items.map((item) => item.destination)).toEqual([
    { kind: 'subject', id: subjectId, title: null },
    { kind: 'account', id: subjectId, title: 'reader' },
    { kind: 'collection', id: collectionId, title: 'Reading shelf' },
    { kind: 'thread', id: reviewId, title: 'A careful reread' },
    { kind: 'space', id: spaceId, title: 'Quiet room', address: 'quiet-room' },
  ]);
  expect(items.map((item) => item.id)).toEqual([
    `discovery:semantic:${subjectId}`,
    `discovery:accounts:${subjectId}`,
    `discovery:commerce:${collectionId}`,
    `discovery:content:${reviewId}`,
    `discovery:content:${spaceId}`,
  ]);
  expect(items[2]?.summary).toEqual(collection.summary.value);
  expect(items[3]?.summary).toEqual(review.summary.value);
  expect(items[4]?.summary).toEqual(space.summary.value);
});

test('mismatched public owner, kind, route or summary identity cannot become a fallback card', () => {
  const invalid = [
    { ...collection, key: { ...collection.key, owner: 'community' } },
    { ...review, key: { ...review.key, kind: 'thread' } },
    { ...space, key: { ...space.key, id: collectionId } },
    { ...space, key: { ...space.key, route: 1 } },
    { ...subject, key: account.key },
    { ...account, key: subject.key },
    { ...subject, key: { ...subject.key, kind: 'schema:Movie' } },
    { ...account, key: { ...account.key, id: reviewId } },
  ];
  for (const hit of invalid)
    expect(() => feedDiscoveryItem(hit as DiscoveryUnionHit)).toThrow(
      expect.objectContaining({ code: 'dependency_unavailable' }),
    );
});
