import { routeOf } from '../route/route.ts';
import type { CollectionDiscoveryKey, CollectionDiscoveryQuery } from '../library/collection-discovery-source.ts';
import type { PublicCollectionDiscoveryOperand } from '../library/collection-discovery-summaries.ts';
import { compareCollectionDiscoveryOperands } from './collection-discovery.ts';
import type { SearchSortValue } from './cursor.ts';
import type { CollectionDirectorySelection, DiscoveryOwnerHit, DiscoveryOwnerMetadataSummary } from './discovery.ts';

export type CollectionDirectoryOrder = 'recency' | 'popularity';
export type CollectionDirectoryRow = Readonly<{
  key: CollectionDiscoveryKey;
  summary: DiscoveryOwnerMetadataSummary<'collection'>;
}>;

/** Mixed/TypeId, curator and contained-subject operands enter hydration; recent/popular become Search order. */
export function collectionDirectoryQuery(selection: CollectionDirectorySelection): CollectionDiscoveryQuery {
  return {
    ...(selection.presentationKind === undefined
      ? {}
      : {
          presentationKind:
            selection.presentationKind === 'mixed'
              ? { kind: 'mixed' as const }
              : { kind: 'owner' as const, id: selection.presentationKind },
        }),
    ...(selection.curator === undefined ? {} : { curatorAccountId: selection.curator }),
    ...(selection.subject === undefined ? {} : { subjectId: selection.subject }),
    ...(selection.order === 'popular' ? { popularity: true } : {}),
    order: selection.order === 'popular' ? 'popularity' : 'recency',
  };
}

export function collectionDirectoryOrder(selection: CollectionDirectorySelection): CollectionDirectoryOrder {
  return selection.order === 'popular' ? 'popularity' : 'recency';
}

export function compareCollectionDirectoryRows(
  left: CollectionDirectoryRow,
  right: CollectionDirectoryRow,
  order: CollectionDirectoryOrder,
): number {
  return compareCollectionDiscoveryOperands(
    { key: left.key, operand: left.summary.operands },
    { key: right.key, operand: right.summary.operands },
    order,
  );
}

/** Complete eligible frontier, newest/highest first, then keyset page. Newly eligible identities sort globally. */
export function sortCollectionDirectory(
  rows: readonly CollectionDirectoryRow[],
  order: CollectionDirectoryOrder,
): CollectionDirectoryRow[] {
  return [...rows].sort((left, right) => compareCollectionDirectoryRows(left, right, order));
}

export function collectionDirectoryCursorAfter(
  row: CollectionDirectoryRow,
  order: CollectionDirectoryOrder,
): SearchSortValue[] {
  const sortKey =
    order === 'popularity' ? row.summary.operands.popularity!.followers : (row.summary.operands.recency[0] ?? '');
  return [sortKey, String(row.key.route), row.key.id];
}

export function parseCollectionDirectoryAfter(
  after: readonly SearchSortValue[],
): { sortKey: string; route: number; id: string } | undefined {
  if (
    after.length !== 3 ||
    typeof after[0] !== 'string' ||
    typeof after[1] !== 'string' ||
    typeof after[2] !== 'string'
  )
    return undefined;
  const route = Number(after[1]);
  if (!Number.isInteger(route) || routeOf(after[2]) !== route) return undefined;
  return { sortKey: after[0], route, id: after[2] };
}

function cursorOperand(
  after: { sortKey: string; route: number; id: string },
  order: CollectionDirectoryOrder,
): PublicCollectionDiscoveryOperand {
  return {
    id: after.id,
    presentationKind: { kind: 'mixed' },
    curator: { state: 'unavailable', reason: 'deidentified' },
    subjectMembership: null,
    popularity: order === 'popularity' ? { followers: after.sortKey } : null,
    recency: [order === 'recency' ? (after.sortKey.length ? after.sortKey : null) : null, after.route, after.id],
    eligible: { presentationKind: null, curator: null, subject: null },
  };
}

export function pageCollectionDirectory(
  ordered: readonly CollectionDirectoryRow[],
  order: CollectionDirectoryOrder,
  after: readonly SearchSortValue[],
  limit: number,
): { items: CollectionDirectoryRow[]; nextAfter: SearchSortValue[] | null } {
  const cursor = after.length === 0 ? undefined : parseCollectionDirectoryAfter(after);
  if (after.length !== 0 && !cursor) throw new TypeError('Invalid Collection directory continuation');
  const start = cursor
    ? ordered.findIndex(
        (row) =>
          compareCollectionDiscoveryOperands(
            { key: row.key, operand: row.summary.operands },
            { key: { route: cursor.route, id: cursor.id }, operand: cursorOperand(cursor, order) },
            order,
          ) > 0,
      )
    : 0;
  const from = start < 0 ? ordered.length : start;
  const items = ordered.slice(from, from + limit);
  return {
    items,
    nextAfter:
      from + items.length < ordered.length && items.length
        ? collectionDirectoryCursorAfter(items.at(-1)!, order)
        : null,
  };
}

export function projectCollectionDirectoryHit(row: CollectionDirectoryRow): DiscoveryOwnerHit {
  const { key, summary } = row;
  return {
    key: { owner: 'library', kind: 'collection', route: key.route, id: key.id },
    summary: {
      kind: 'collection',
      value: {
        id: summary.id,
        title: summary.title,
        description: summary.summary,
        card: structuredClone(summary.card),
      },
    },
  };
}

export function collectionDirectoryRows(
  summaries: ReadonlyMap<string, DiscoveryOwnerMetadataSummary<'collection'>>,
): CollectionDirectoryRow[] {
  const rows: CollectionDirectoryRow[] = [];
  for (const [id, summary] of summaries) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Collection directory row is not a canonical identity');
    rows.push({ key: { route, id }, summary });
  }
  return rows;
}
