import { expect, test } from 'bun:test';
import type { PublicCollectionDiscoverySummary } from '../../src/library/index.ts';
import type { PublicCollectionDiscoveryOperand } from '../../src/library/collection-discovery-summaries.ts';
import {
  collectionDirectoryOrder,
  collectionDirectoryQuery,
  collectionDirectoryRows,
  pageCollectionDirectory,
  parseCollectionDirectoryAfter,
  projectCollectionDirectoryHit,
  sortCollectionDirectory,
  type CollectionDirectoryRow,
} from '../../src/search/collection-directory.ts';
import type { DiscoveryOwnerMetadataSummary } from '../../src/search/discovery.ts';

const older = '018f0000-0000-7000-8000-00a000000001';
const newer = '018f0000-0000-7000-8000-00a000000002';
const popular = '018f0000-0000-7000-8000-00a000000003';
const route = 160;

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
  const inserted = row('018f0000-0000-7000-8000-00a000000004', {
    recency: ['250', route, '018f0000-0000-7000-8000-00a000000004'],
    popularity: { followers: '1' },
  });
  const refreshed = pageCollectionDirectory(
    sortCollectionDirectory([...ordered, inserted], 'recency'),
    'recency',
    [],
    2,
  );
  expect(refreshed.items.map((item) => item.key.id)).toEqual([older, '018f0000-0000-7000-8000-00a000000004']);
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
