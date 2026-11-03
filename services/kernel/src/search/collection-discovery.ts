import { partitionOf, routeOf } from '../route/route.ts';

export const COLLECTION_DISCOVERY_BATCH_SIZE = 100;

export type CollectionDiscoveryPageKey = Readonly<{ route: number; id: string }>;

/** A producer row contains only the public Collection metadata admitted to Search. */
export type PublicCollectionDiscoveryRow = Readonly<{
  id: string;
  visibility: 'public';
  revision: bigint;
  title: string;
  description: string | null;
}>;

export type PublicCollectionDiscoverySnapshot = Readonly<{
  partition: number;
  position: bigint;
  collections: readonly PublicCollectionDiscoveryRow[];
}>;

export type PublicCollectionDiscoveryPage = PublicCollectionDiscoverySnapshot &
  Readonly<{
    /** True only after the producer has validated its whole native page before returning a frontier. */
    complete: boolean;
    next: CollectionDiscoveryPageKey | null;
  }>;

/** Named seam for Commerce's planned publicCollectionDiscoverySource(pool). */
export interface PublicCollectionDiscoverySource {
  read(partition: number, ids: readonly string[]): Promise<PublicCollectionDiscoverySnapshot>;
  /** A generation census only; it is not query-count evidence. */
  count(partition: number): Promise<{ partition: number; position: bigint; count: number }>;
  page(
    partition: number,
    after: CollectionDiscoveryPageKey | null,
    limit: number,
  ): Promise<PublicCollectionDiscoveryPage>;
}

/** Current authorized shell fields only. The destination is supplied by Commerce's canonical route reader. */
export type PublicCollectionDiscoverySummary = Readonly<{
  id: string;
  title: string;
  description: string | null;
  destination: string;
}>;

export type CollectionDiscoverySummaryReader<Context> = (
  ids: readonly string[],
  context: Context,
) => Promise<ReadonlyMap<string, PublicCollectionDiscoverySummary | null | undefined>>;

export type CollectionDiscoveryProducer<Context> =
  | Readonly<{
      status: 'ready';
      source: PublicCollectionDiscoverySource;
      readSummaries: CollectionDiscoverySummaryReader<Context>;
    }>
  | Readonly<{ status: 'preparing' | 'unavailable'; reason?: string }>;

export class CollectionDiscoveryReadinessError extends Error {
  readonly status: 'preparing' | 'unavailable';

  constructor(status: 'preparing' | 'unavailable', message: string) {
    super(message);
    this.name = 'CollectionDiscoveryReadinessError';
    this.status = status;
  }
}

export type CollectionDiscoveryAdapter<Context> =
  | Readonly<{
      status: 'ready';
      source: PublicCollectionDiscoverySource;
      hydrate(ids: readonly string[], context: Context): Promise<ReadonlyMap<string, PublicCollectionDiscoverySummary>>;
    }>
  | Readonly<{ status: 'preparing' | 'unavailable'; reason: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyOf(id: string): CollectionDiscoveryPageKey {
  const route = routeOf(id);
  if (route === null || id !== id.toLowerCase())
    throw new TypeError('Collection discovery requires a canonical full UUID key');
  return { route, id };
}

function partitionKey(partition: number): number {
  if (!Number.isSafeInteger(partition) || partition < 0) throw new RangeError('Invalid Collection discovery partition');
  return partition;
}

function compareKeys(left: CollectionDiscoveryPageKey, right: CollectionDiscoveryPageKey): number {
  if (left.route !== right.route) return left.route - right.route;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateIds(ids: readonly string[], maximum: number): Set<string> {
  if (!Array.isArray(ids) || ids.length > maximum) throw new RangeError('Collection discovery batch exceeds its bound');
  const keys = new Set<string>();
  for (const id of ids) {
    keyOf(id);
    if (keys.has(id)) throw new TypeError('Collection discovery batch contains a duplicate full key');
    keys.add(id);
  }
  return keys;
}

function validateSnapshot(
  value: unknown,
  partition: number,
  requested?: ReadonlySet<string>,
): PublicCollectionDiscoverySnapshot {
  if (
    !record(value) ||
    value.partition !== partition ||
    typeof value.position !== 'bigint' ||
    value.position < 0n ||
    !Array.isArray(value.collections)
  )
    throw new TypeError('Invalid native Collection discovery snapshot');

  const position = value.position;
  const ids = new Set<string>();
  const collections = value.collections.map((candidate): PublicCollectionDiscoveryRow => {
    if (
      !record(candidate) ||
      candidate.visibility !== 'public' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.revision !== 'bigint' ||
      candidate.revision < 0n ||
      candidate.revision > position ||
      typeof candidate.title !== 'string' ||
      candidate.title.trim().length === 0 ||
      (candidate.description !== null && typeof candidate.description !== 'string')
    )
      throw new TypeError('Invalid public Collection discovery row or native position');

    const key = keyOf(candidate.id);
    if (partitionOf(key.route) !== partition || (requested && !requested.has(key.id)))
      throw new RangeError('Collection discovery returned a wrong full key');
    if (ids.has(key.id)) throw new TypeError('Collection discovery returned a duplicate full key');
    ids.add(key.id);
    return {
      id: key.id,
      visibility: 'public',
      revision: candidate.revision,
      title: candidate.title,
      description: candidate.description,
    };
  });

  return { partition, position, collections };
}

function validateCount(value: unknown, partition: number) {
  if (
    !record(value) ||
    value.partition !== partition ||
    typeof value.position !== 'bigint' ||
    value.position < 0n ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    throw new TypeError('Invalid native Collection discovery census');
  return { partition, position: value.position, count: value.count };
}

function validatePageKey(value: unknown, partition: number): CollectionDiscoveryPageKey {
  if (
    !record(value) ||
    typeof value.route !== 'number' ||
    !Number.isSafeInteger(value.route) ||
    typeof value.id !== 'string'
  )
    throw new TypeError('Invalid Collection discovery frontier key');
  const key = keyOf(value.id);
  if (key.route !== value.route || partitionOf(key.route) !== partition)
    throw new RangeError('Collection discovery frontier has a wrong full key');
  return key;
}

function validatePage(
  value: unknown,
  partition: number,
  after: CollectionDiscoveryPageKey | null,
  limit: number,
): PublicCollectionDiscoveryPage {
  if (!record(value) || value.complete !== true)
    throw new CollectionDiscoveryReadinessError('preparing', 'Collection discovery producer page is incomplete');
  const snapshot = validateSnapshot(value, partition);
  if (snapshot.collections.length > limit)
    throw new RangeError('Collection discovery producer exceeded its page bound');

  const keys = snapshot.collections.map(({ id }) => keyOf(id));
  for (let index = 0; index < keys.length; index++) {
    if (after && compareKeys(keys[index]!, after) <= 0)
      throw new RangeError('Collection discovery page did not advance its full-key frontier');
    if (index > 0 && compareKeys(keys[index - 1]!, keys[index]!) >= 0)
      throw new TypeError('Collection discovery page is not in strict native key order');
  }

  const next = value.next === null ? null : validatePageKey(value.next, partition);
  if (next && (!keys.length || keys.length !== limit || compareKeys(next, keys.at(-1)!) !== 0))
    throw new TypeError('Collection discovery page frontier does not match its complete page');
  return { ...snapshot, complete: true, next };
}

/**
 * Adapt Commerce's source without caching summaries or inventing coverage. A missing/not-ready producer stays
 * typed readiness; ready pages are validated before their keyset frontier can leave this boundary.
 */
export function createCollectionDiscoveryAdapter<Context>(
  producer: CollectionDiscoveryProducer<Context> | null | undefined,
): CollectionDiscoveryAdapter<Context> {
  if (!producer) return { status: 'unavailable', reason: 'commerce_collection_discovery_producer_not_installed' };
  if (producer.status !== 'ready')
    return {
      status: producer.status,
      reason: producer.reason ?? `commerce_collection_discovery_${producer.status}`,
    };
  if (
    !producer.source ||
    typeof producer.source.read !== 'function' ||
    typeof producer.source.count !== 'function' ||
    typeof producer.source.page !== 'function' ||
    typeof producer.readSummaries !== 'function'
  )
    return { status: 'preparing', reason: 'commerce_collection_discovery_contract_incomplete' };

  const source: PublicCollectionDiscoverySource = {
    async read(partitionValue, ids) {
      const partition = partitionKey(partitionValue);
      const requested = validateIds(ids, COLLECTION_DISCOVERY_BATCH_SIZE);
      if (ids.some((id) => partitionOf(keyOf(id).route) !== partition))
        throw new RangeError('Collection discovery read key belongs to another partition');
      return validateSnapshot(await producer.source.read(partition, ids), partition, requested);
    },
    async count(partitionValue) {
      const partition = partitionKey(partitionValue);
      return validateCount(await producer.source.count(partition), partition);
    },
    async page(partitionValue, afterValue, limit) {
      const partition = partitionKey(partitionValue);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > COLLECTION_DISCOVERY_BATCH_SIZE)
        throw new RangeError('Collection discovery page limit is outside its bound');
      const after = afterValue === null ? null : validatePageKey(afterValue, partition);
      return validatePage(await producer.source.page(partition, after, limit), partition, after, limit);
    },
  };

  return {
    status: 'ready',
    source,
    async hydrate(ids, context) {
      const requested = validateIds(ids, COLLECTION_DISCOVERY_BATCH_SIZE);
      const current = await producer.readSummaries(ids, context);
      if (!current || typeof current[Symbol.iterator] !== 'function')
        throw new TypeError('Collection discovery summary reader did not return a map');
      const summaries = new Map<string, PublicCollectionDiscoverySummary>();
      for (const [id, value] of current) {
        if (!requested.has(id)) throw new RangeError('Collection discovery summary has a wrong full key');
        if (value === null || value === undefined) continue;
        if (
          !record(value) ||
          value.id !== id ||
          typeof value.title !== 'string' ||
          value.title.trim().length === 0 ||
          (value.description !== null && typeof value.description !== 'string') ||
          typeof value.destination !== 'string' ||
          value.destination.length === 0
        )
          throw new TypeError('Invalid current public Collection discovery summary');
        summaries.set(id, {
          id,
          title: value.title,
          description: value.description,
          destination: value.destination,
        });
      }
      return summaries;
    },
  };
}
