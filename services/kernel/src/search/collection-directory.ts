import { partitionOf, routeOf } from '../route/route.ts';
import type {
  CollectionDiscoveryKey,
  CollectionDiscoveryQuery,
  CollectionDiscoverySource,
} from '../library/collection-discovery-source.ts';
import type { PublicCollectionDiscoveryOperand } from '../library/collection-discovery-summaries.ts';
import {
  COLLECTION_DISCOVERY_BATCH_SIZE,
  CollectionDiscoveryReadinessError,
  compareCollectionDiscoveryOperands,
} from './collection-discovery.ts';
import type { SearchSortValue } from './cursor.ts';
import type {
  CollectionDirectorySelection,
  DiscoveryOwnerAdapter,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
  DiscoveryRegistry,
  DiscoveryOwnerHit,
} from './discovery.ts';

export type CollectionDirectoryOrder = 'recency' | 'popularity';
export type CollectionDirectoryRow = Readonly<{
  key: CollectionDiscoveryKey;
  summary: DiscoveryOwnerMetadataSummary<'collection'>;
}>;
export type CollectionDirectoryFrontier = Readonly<{
  identities: readonly string[];
  examined: number;
  exhausted: boolean;
}>;
export type CollectionDirectoryPage = Readonly<{
  items: CollectionDirectoryRow[];
  nextAfter: SearchSortValue[] | null;
  exhausted: boolean;
}>;

function partitionOfId(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Collection directory identity is not a canonical UUID');
  return partitionOf(route);
}

function keyOf(id: string): CollectionDiscoveryKey {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Collection directory identity is not a canonical UUID');
  return { route, id };
}

function compareIdentity(left: CollectionDiscoveryKey, right: CollectionDiscoveryKey): number {
  return left.route - right.route || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** Directory runs only when Commerce advertised the listing predicates on a ready Collection adapter. */
export function hasCollectionDirectoryCapability(
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
): boolean {
  const slot = registry.ownerAdapters?.collection;
  if (slot?.readiness !== 'ready') return false;
  try {
    return registry.domains?.('collection')?.includes('collectionDirectory') === true;
  } catch {
    return false;
  }
}

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

/**
 * Identity-ordered native complete pages, including unavailable publication witnesses. Search never uses this
 * order as the result order: recency/popularity run after current hydration of the whole eligible frontier.
 *
 * Cost
 * - Touches: one `source.page` per raw LIMIT window per occupied partition, plus one empty currentness read
 *   per partition after the last page.
 * - Bound: each page is at most 100 raw keys; examined identities stay within `scanBound`. Incomplete native
 *   pages or a frontier that cannot finish inside the bound stay readiness.
 * - Growth check: focused directory tests walk a tail past the first owner batch; three-scale growth stays
 *   with integration.
 */
export async function consumeCollectionDirectoryFrontier(input: {
  source: CollectionDiscoverySource;
  partitions: readonly number[];
  query: CollectionDiscoveryQuery;
  deadline: number;
  scanBound: number;
}): Promise<CollectionDirectoryFrontier> {
  if (!Number.isSafeInteger(input.scanBound) || input.scanBound < 1)
    throw new RangeError('Collection directory scan bound is invalid');
  const identities: string[] = [];
  const seen = new Set<string>();
  let examined = 0;
  for (const partition of input.partitions) {
    let after: CollectionDiscoveryKey | null = null;
    let stamp: { epoch: number; position: string } | undefined;
    for (;;) {
      const remaining = input.scanBound - examined;
      if (remaining < 1) {
        throw new CollectionDiscoveryReadinessError('unavailable', 'collection_directory_frontier_exceeds_bound');
      }
      const limit = Math.min(COLLECTION_DISCOVERY_BATCH_SIZE, remaining);
      const page = await input.source.page(partition, after, limit, input.query, { deadline: input.deadline });
      if (page.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', page.reason);
      if (stamp && (stamp.epoch !== page.stamp.epoch || stamp.position !== page.stamp.position))
        throw new CollectionDiscoveryReadinessError('unavailable', 'current_source_changed');
      stamp ??= { epoch: page.stamp.epoch, position: page.stamp.position };
      examined += page.items.length;
      if (examined > input.scanBound)
        throw new CollectionDiscoveryReadinessError('unavailable', 'collection_directory_frontier_exceeds_bound');
      for (const item of page.items) {
        if (seen.has(item.key.id)) continue;
        seen.add(item.key.id);
        if (item.status === 'indexable') identities.push(item.key.id);
      }
      if (page.next === null) break;
      after = page.next;
    }
    const current = await input.source.read(partition, [], input.query, { deadline: input.deadline });
    if (current.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', current.reason);
    if (stamp && (stamp.epoch !== current.stamp.epoch || stamp.position !== current.stamp.position))
      throw new CollectionDiscoveryReadinessError('unavailable', 'current_source_changed');
  }
  return { identities, examined, exhausted: true };
}

/**
 * Occupied partitions for an already collected identity frontier. OpenSearch supplies those identities; native
 * `source.page` remains the indexing frontier and is not inferred from an empty partition scan.
 */
export function collectionDirectoryPartitions(identities: readonly string[]): number[] {
  const partitions = new Set<number>();
  for (const id of identities) partitions.add(partitionOfId(id));
  return [...partitions].sort((left, right) => left - right);
}

/** Current public owner observations for the complete identity frontier, in native batches of at most 100. */
export async function hydrateCollectionDirectory(
  readCurrent: DiscoveryOwnerAdapter<'collection', 'commerce'>['readCurrent'],
  identities: readonly string[],
  context: DiscoveryReadContext,
): Promise<Map<string, DiscoveryOwnerMetadataSummary<'collection'>>> {
  const current = new Map<string, DiscoveryOwnerMetadataSummary<'collection'>>();
  const unique = [...new Set(identities)];
  for (let offset = 0; offset < unique.length; offset += COLLECTION_DISCOVERY_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + COLLECTION_DISCOVERY_BATCH_SIZE);
    const summaries = await readCurrent(batch, context);
    for (const [id, summary] of summaries) current.set(id, summary);
  }
  return current;
}

export type CollectionDirectoryExecute = Readonly<{
  identities: readonly string[];
  readCurrent: DiscoveryOwnerAdapter<'collection', 'commerce'>['readCurrent'];
  revalidate: (
    summaries: ReadonlyMap<string, DiscoveryOwnerMetadataSummary<'collection'>>,
    context: DiscoveryReadContext,
  ) => Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary<'collection'>>>;
  selection: CollectionDirectorySelection;
  context: DiscoveryReadContext;
  after: readonly SearchSortValue[];
  limit: number;
}>;

/**
 * Hydrate the complete eligible frontier with `collectionQuery`, apply recency/popularity, then page by sort
 * keyset. A newly eligible identity belongs in its global position; continuation is never an OpenSearch prefix.
 *
 * Cost
 * - Touches: `ceil(n/100)` current reads plus one revalidation of the accepted rows.
 * - Bound: n is the identity frontier already bounded by the scan; each current read is 100 identities.
 * - Growth check: focused tests cover a resumed cursor, recency ties, popularity, removal and owner changes.
 */
export async function executeCollectionDirectory(input: CollectionDirectoryExecute): Promise<CollectionDirectoryPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1)
    throw new RangeError('Collection directory page limit is invalid');
  const hydrated = await hydrateCollectionDirectory(input.readCurrent, input.identities, input.context);
  const current = await input.revalidate(hydrated, input.context);
  const order = collectionDirectoryOrder(input.selection);
  const paged = pageCollectionDirectory(
    sortCollectionDirectory(collectionDirectoryRows(current), order),
    order,
    input.after,
    input.limit,
  );
  return {
    items: paged.items,
    nextAfter: paged.nextAfter,
    exhausted: paged.nextAfter === null,
  };
}

/** Ordered identity keys for a native source walk used by the mounted directory consumer. */
export function collectionDirectoryIdentityKeys(identities: readonly string[]): CollectionDiscoveryKey[] {
  return [...identities].map(keyOf).sort(compareIdentity);
}

/** Project the executed directory page into mixed-discovery hits without operands or query observation. */
export function projectCollectionDirectoryPage(page: CollectionDirectoryPage): DiscoveryOwnerHit[] {
  return page.items.map(projectCollectionDirectoryHit);
}
