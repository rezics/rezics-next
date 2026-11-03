import {
  publicCollectionDiscoverySource,
  type CollectionDiscoverySource,
  type CollectionDiscoveryKey,
  type CollectionDiscoverySnapshot,
  type CollectionDiscoveryPage,
  type CollectionDiscoveryItem,
} from '../library/collection-discovery-source.ts';
import {
  readPublicCollectionDiscoverySummaries,
  type PublicCollectionDiscoveryDependencies,
  type PublicCollectionDiscoveryContext,
  type PublicCollectionDiscoveryResult,
  type PublicCollectionDiscoverySummary,
} from '../library/collection-discovery-summaries.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { DiscoveryOwnerAdapter, DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from './discovery.ts';

export const COLLECTION_DISCOVERY_BATCH_SIZE = 100;
export type CollectionDiscoveryPageKey = CollectionDiscoveryKey;
export type PublicCollectionDiscoverySource = CollectionDiscoverySource;
export type { PublicCollectionDiscoveryContext, PublicCollectionDiscoveryResult, PublicCollectionDiscoverySummary };

export type CollectionDiscoverySummaryReader = (
  ids: readonly string[],
  context: PublicCollectionDiscoveryContext,
) => Promise<PublicCollectionDiscoveryResult>;
export type CollectionDiscoveryProducer =
  | Readonly<{
      status: 'ready';
      source: CollectionDiscoverySource;
      readSummaries: CollectionDiscoverySummaryReader;
    }>
  | Readonly<{ status: 'preparing' | 'unavailable'; reason?: string }>;

/** The installed registry's map-only current-reader port cannot encode native unavailability. */
export class CollectionDiscoveryReadinessError extends Error {
  readonly status: 'preparing' | 'unavailable';
  readonly reason: string;

  constructor(status: 'preparing' | 'unavailable', reason: string) {
    super(reason);
    this.name = 'CollectionDiscoveryReadinessError';
    this.status = status;
    this.reason = reason;
  }
}

type ReadyCollectionDiscoveryAdapter = Readonly<{
  status: 'ready';
  source: CollectionDiscoverySource;
  hydrate: CollectionDiscoverySummaryReader;
}>;
export type CollectionDiscoveryAdapter =
  | ReadyCollectionDiscoveryAdapter
  | Readonly<{ status: 'preparing' | 'unavailable'; reason: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function partitionKey(partition: number): number {
  if (!Number.isSafeInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid Collection discovery partition');
  return partition;
}
function keyOf(id: string): CollectionDiscoveryKey {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Collection discovery requires a canonical full UUID key');
  return { route, id };
}
function keyIn(value: unknown, partition: number): CollectionDiscoveryKey {
  if (!record(value) || typeof value.id !== 'string') throw new TypeError('Invalid Collection discovery full key');
  const key = keyOf(value.id);
  if (key.route !== value.route || partitionOf(key.route) !== partition)
    throw new RangeError('Collection discovery returned a wrong full key');
  return key;
}
function compare(left: CollectionDiscoveryKey, right: CollectionDiscoveryKey): number {
  return left.route - right.route || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function bounded(values: readonly unknown[], maximum = COLLECTION_DISCOVERY_BATCH_SIZE) {
  if (!Array.isArray(values) || values.length > maximum)
    throw new RangeError('Collection discovery batch exceeds its bound');
}
function idsIn(ids: readonly string[], partition: number): string[] {
  bounded(ids);
  for (const id of ids) keyIn(keyOf(id), partition);
  return [...new Set(ids)];
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Copy only native indexing hints. Neither the hint nor a source stamp authorizes a card. */
function item(value: unknown, partition: number): CollectionDiscoveryItem {
  if (!record(value)) throw new TypeError('Invalid native Collection discovery item');
  const key = keyIn(value.key, partition);
  if (value.status === 'withdrawn') return { key, status: 'withdrawn' };
  if (value.status === 'unavailable' && value.reason === 'selected_publication_witness_unavailable')
    return { key, status: 'unavailable', reason: value.reason };
  const row = value.value;
  if (
    value.status !== 'indexable' ||
    !record(row) ||
    row.kind !== 'collection' ||
    compare(key, keyIn(row.key, partition)) !== 0 ||
    !integer(row.revision) ||
    typeof row.title !== 'string' ||
    !nullableText(row.description) ||
    !nullableText(row.presentationKind) ||
    !nullableText(row.coverMediaId)
  )
    throw new TypeError('Invalid native Collection discovery value');
  const common = {
    kind: 'collection' as const,
    key,
    revision: row.revision,
    title: row.title,
    description: row.description,
    presentationKind: row.presentationKind,
    coverMediaId: row.coverMediaId,
  };
  if (row.membershipKind === 'curated' && row.output === null)
    return { key, status: 'indexable', value: { ...common, membershipKind: 'curated', output: null } };
  if (
    row.membershipKind !== 'dynamic' ||
    !record(row.output) ||
    row.output.route !== key.route ||
    row.output.collectionId !== key.id ||
    typeof row.output.generation !== 'string' ||
    !row.output.generation
  )
    throw new TypeError('Invalid native Collection publication witness');
  return {
    key,
    status: 'indexable',
    value: {
      ...common,
      membershipKind: 'dynamic',
      output: { route: key.route, collectionId: key.id, generation: row.output.generation },
    },
  };
}
function snapshot(value: CollectionDiscoverySnapshot, partition: number): CollectionDiscoverySnapshot {
  if (value.status === 'unavailable') {
    if (value.reason !== 'native_partition_unavailable') throw new TypeError('Invalid native partition status');
    return { status: 'unavailable', reason: value.reason };
  }
  if (
    value.status !== 'available' ||
    !record(value.stamp) ||
    value.stamp.partition !== partition ||
    !integer(value.stamp.epoch) ||
    typeof value.stamp.position !== 'string' ||
    !value.stamp.position ||
    !Array.isArray(value.items)
  )
    throw new TypeError('Invalid native Collection discovery snapshot');
  // Position belongs to the partition log; Collection revision belongs to the Collection.
  const stamp = { partition, epoch: value.stamp.epoch, position: value.stamp.position };
  bounded(value.items);
  const items = value.items.map((value) => item(value, partition));
  for (let index = 1; index < items.length; index++)
    if (compare(items[index - 1]!.key, items[index]!.key) >= 0)
      throw new TypeError('Collection discovery keys are not in strict native order');
  return { status: 'available', stamp, items };
}
function page(
  value: CollectionDiscoveryPage,
  partition: number,
  after: CollectionDiscoveryKey | null,
  limit: number,
): CollectionDiscoveryPage {
  const current = snapshot(value, partition);
  if (current.status === 'unavailable') {
    if (value.next !== null) throw new TypeError('Unavailable Collection page has a frontier');
    return { ...current, next: null };
  }
  if (current.items.length > limit) throw new RangeError('Collection discovery exceeded its raw page bound');
  for (const { key } of current.items)
    if (after && compare(key, after) <= 0) throw new RangeError('Collection discovery frontier did not advance');
  const next = value.next === null ? null : keyIn(value.next, partition);
  const last = current.items.at(-1)?.key;
  // A native page is complete over RAW keys, including unavailable publication witnesses.
  if (current.items.length === limit ? !next || !last || compare(next, last) !== 0 : next !== null)
    throw new TypeError('Collection discovery frontier does not match its raw page');
  return { ...current, next };
}
function summaries(value: PublicCollectionDiscoveryResult, ids: readonly string[]): PublicCollectionDiscoveryResult {
  if (value.state === 'unavailable') {
    if (!['native_authority', 'changed', 'access', 'partition', 'deadline'].includes(value.reason))
      throw new TypeError('Invalid current Collection disclosure status');
    return { state: 'unavailable', reason: value.reason };
  }
  if (value.state !== 'ready' || !Array.isArray(value.summaries))
    throw new TypeError('Invalid current Collection summaries');
  const byId = new Map<string, PublicCollectionDiscoverySummary>();
  for (const card of value.summaries) {
    if (
      !ids.includes(card.id) ||
      byId.has(card.id) ||
      card.kind !== 'collection' ||
      card.visibility !== 'public' ||
      card.destination !== `/collections/${card.id}` ||
      !integer(card.revision) ||
      typeof card.title !== 'string' ||
      !nullableText(card.description)
    )
      throw new TypeError('Invalid current public Collection summary');
    const common = {
      kind: 'collection' as const,
      visibility: 'public' as const,
      id: card.id,
      destination: card.destination,
      title: card.title,
      description: card.description,
      revision: card.revision,
      presentationKind: card.presentationKind,
      presentationKindSource: card.presentationKindSource,
      cover: card.cover,
      coverSource: card.coverSource,
    };
    if (card.membershipKind === 'curated') {
      if (
        !integer(card.memberCount) ||
        !integer(card.orderEpoch) ||
        !Number.isFinite(Date.parse(card.createdAt)) ||
        !Number.isFinite(Date.parse(card.updatedAt))
      )
        throw new TypeError('Invalid current curated Collection summary');
      byId.set(card.id, {
        ...common,
        membershipKind: 'curated',
        memberCount: card.memberCount,
        orderEpoch: card.orderEpoch,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      });
    } else if (
      card.membershipKind === 'dynamic' &&
      typeof card.outputGeneration === 'string' &&
      card.outputGeneration
    ) {
      byId.set(card.id, { ...common, membershipKind: 'dynamic', outputGeneration: card.outputGeneration });
    } else throw new TypeError('Invalid current dynamic Collection summary');
  }
  return { state: 'ready', summaries: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) };
}

/** Validation boundary over the installed Commerce contracts, also usable by owner contract tests. */
export function createCollectionDiscoveryAdapter(
  producer: CollectionDiscoveryProducer | null | undefined,
): CollectionDiscoveryAdapter {
  if (!producer) return { status: 'unavailable', reason: 'commerce_collection_discovery_producer_not_installed' };
  if (producer.status !== 'ready')
    return { status: producer.status, reason: producer.reason ?? `commerce_collection_discovery_${producer.status}` };
  if (!producer.source?.read || !producer.source.page || !producer.source.count || !producer.readSummaries)
    return { status: 'preparing', reason: 'commerce_collection_discovery_contract_incomplete' };
  return {
    status: 'ready',
    source: {
      async read(partitionValue, values) {
        const partition = partitionKey(partitionValue);
        bounded(values);
        const keys = [
          ...new Map(
            values.map((value) => {
              const key = keyIn(value, partition);
              return [key.id, key] as const;
            }),
          ).values(),
        ].sort(compare);
        const result = snapshot(await producer.source.read(partition, keys), partition);
        if (
          result.status === 'available' &&
          (result.items.length !== keys.length || result.items.some((item, i) => compare(item.key, keys[i]!) !== 0))
        )
          throw new TypeError('Collection discovery read did not settle every requested full key');
        return result;
      },
      async count(partitionValue) {
        const result = await producer.source.count(partitionKey(partitionValue));
        if (result.status !== 'unavailable' || result.reason !== 'native_collection_population_evidence_unavailable')
          throw new TypeError('Collection discovery has no native census authority');
        return { status: 'unavailable', reason: result.reason };
      },
      async page(partitionValue, afterValue, limit) {
        const partition = partitionKey(partitionValue);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > COLLECTION_DISCOVERY_BATCH_SIZE)
          throw new RangeError('Collection discovery page limit is outside its bound');
        const after = afterValue === null ? null : keyIn(afterValue, partition);
        return page(await producer.source.page(partition, after, limit), partition, after, limit);
      },
    },
    async hydrate(ids, context) {
      const requested = idsIn(ids, partitionKey(context.partition));
      return summaries(await producer.readSummaries(requested, context), requested);
    },
  };
}

export type NativeCollectionDiscoveryAdapter = ReadyCollectionDiscoveryAdapter &
  Readonly<{
    /** Current metadata port for createNativeDiscoveryRegistry's ownerAdapters.collection. */
    registration: Readonly<{ readiness: 'ready'; adapter: DiscoveryOwnerAdapter<'collection', 'commerce'> }>;
  }>;

/** Connect the native source and current disclosure reader; this is not generation readiness. */
export function createNativeCollectionDiscoveryAdapter(
  dependencies: PublicCollectionDiscoveryDependencies,
  metadata: DiscoveryOwnerAdapter<'collection', 'commerce'>['metadata'],
): NativeCollectionDiscoveryAdapter {
  const leaf = createCollectionDiscoveryAdapter({
    status: 'ready',
    source: publicCollectionDiscoverySource({ pool: dependencies.pool }),
    readSummaries: (ids, context) => readPublicCollectionDiscoverySummaries(dependencies, ids, context),
  });
  if (leaf.status !== 'ready') throw new CollectionDiscoveryReadinessError(leaf.status, leaf.reason);
  return {
    ...leaf,
    registration: {
      readiness: 'ready',
      adapter: {
        owner: 'commerce',
        kind: 'collection',
        metadata,
        async readCurrent(ids, context: DiscoveryReadContext) {
          // The installed mixed reader admits at most 200 keys. Native batches stay partition-local.
          bounded(ids, 200);
          const groups = new Map<number, string[]>();
          for (const id of new Set(ids)) {
            const partition = partitionOf(keyOf(id).route);
            const group = groups.get(partition) ?? [];
            group.push(id);
            groups.set(partition, group);
          }
          const current = new Map<string, DiscoveryOwnerMetadataSummary>();
          for (const [partition, group] of groups) {
            for (let offset = 0; offset < group.length; offset += COLLECTION_DISCOVERY_BATCH_SIZE) {
              const batch = group.slice(offset, offset + COLLECTION_DISCOVERY_BATCH_SIZE);
              // Use this request's Access, actor and deadline, never a cached viewer or indexing hint.
              const result = summaries(
                await readPublicCollectionDiscoverySummaries({ ...dependencies, access: context.access }, batch, {
                  actor: context.actor,
                  partition,
                  deadline: context.deadline,
                }),
                batch,
              );
              if (result.state === 'unavailable')
                throw new CollectionDiscoveryReadinessError('unavailable', result.reason);
              for (const card of result.summaries)
                current.set(card.id, { id: card.id, title: card.title, summary: card.description });
            }
          }
          return new Map([...new Set(ids)].flatMap((id) => (current.has(id) ? [[id, current.get(id)!]] : [])));
        },
      },
    },
  };
}
