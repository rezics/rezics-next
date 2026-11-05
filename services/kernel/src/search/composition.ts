import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CollectionDiscoveryReadinessError, createNativeCollectionDiscoveryAdapter } from './collection-discovery.ts';
import { createReviewDiscoveryAdapter } from './review-discovery.ts';
import type { SpaceDiscoveryAdapter } from './space-discovery.ts';
import type { IndexedSpace, SpaceDiscoverySummary } from '../community/index.ts';
import {
  REVIEW_DISCOVERY_PAGE_LIMIT,
  type IndexedReview,
  type ReviewDiscoverySource,
} from '../content/review-discovery.ts';
import type { CollectionDiscoveryItem, CollectionDiscoverySource } from '../library/collection-discovery-source.ts';
import type {
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerMetadataSummary,
  DiscoveryReadContext,
} from './discovery.ts';
import type {
  DiscoveryMetadataKind,
  DiscoveryMetadataProducer,
  DiscoveryMetadataProducers,
} from './discovery-api.ts';
import { DiscoveryPopulationCutChangedError, DiscoveryProducerCoverageError } from './generations.ts';
import type { SecondScopeDiscoveryKey, SecondScopeDiscoveryRecord } from './discovery-documents.ts';

export type DiscoveryOwnerAdapters = DiscoveryOwnerAdapterSlots & Readonly<{
  metadataProducers: DiscoveryMetadataProducers;
}>;

function metadataKey(owner: 'commerce' | 'content', kind: 'collection' | 'review' | 'space', id: string) {
  const route = routeOf(id);
  if (route === null) throw new TypeError(`Invalid native ${kind} identity`);
  return { owner, kind, route, id } as SecondScopeDiscoveryKey;
}

function requestedKeys(
  owner: 'commerce' | 'content',
  kind: 'collection' | 'review' | 'space',
  partition: number,
  ids: readonly string[],
): SecondScopeDiscoveryKey[] {
  if (!Array.isArray(ids) || ids.length > 100) throw new RangeError(`Native ${kind} read exceeds 100 identities`);
  const unique = [...new Set(ids)];
  const keys = unique.map((id) => metadataKey(owner, kind, id));
  if (keys.some((key) => partitionOf(key.route) !== partition))
    throw new TypeError(`Native ${kind} identities cross their source partition`);
  return keys;
}

function collectionRecords(
  items: readonly CollectionDiscoveryItem[],
) {
  const records: SecondScopeDiscoveryRecord[] = [];
  for (const item of items) {
    if (item.status === 'unavailable') throw new CollectionDiscoveryReadinessError('unavailable', item.reason);
    if (item.status !== 'indexable') continue;
    records.push({
      key: { owner: 'commerce', kind: 'collection', ...item.key },
      revision: BigInt(item.value.revision),
      sourceVersion: null,
      names: [item.value.title],
      descriptions: [],
      nameSort: item.value.title,
    });
  }
  return records;
}

function reviewRecords(
  partition: number,
  position: bigint,
  reviews: readonly IndexedReview[],
) {
  const records: SecondScopeDiscoveryRecord[] = [];
  for (const review of reviews) {
    const key = metadataKey('content', 'review', review.id);
    if (partitionOf(key.route) !== partition) throw new TypeError('Review source returned a foreign partition key');
    if (
      !Object.prototype.propertyIsEnumerable.call(review, 'sourceVersion') ||
      typeof review.sourceVersion !== 'string' ||
      !review.sourceVersion ||
      !review.sourceVersion.isWellFormed()
    )
      throw new TypeError('Review source version is invalid');
    const excerpt = review.excerpt ?? '';
    records.push({
      key,
      revision: position,
      sourceVersion: review.sourceVersion,
      names: review.title === null ? [] : [review.title],
      descriptions: [excerpt],
      nameSort: review.title,
    });
  }
  return records;
}

function spaceRecords(partition: number, spaces: readonly IndexedSpace[]) {
  return spaces.map((space): SecondScopeDiscoveryRecord => {
    const key = metadataKey('content', 'space', space.id);
    if (partitionOf(key.route) !== partition) throw new TypeError('Space source returned a foreign partition key');
    return {
      key,
      revision: BigInt(space.revision),
      sourceVersion: null,
      names: [space.name],
      descriptions: [space.description],
      nameSort: space.name,
    };
  });
}

function createCollectionPopulationProducer(
  adapter: ReturnType<typeof createNativeCollectionDiscoveryAdapter>,
): DiscoveryMetadataProducer {
  return {
    kind: 'collection',
    owner: 'commerce',
    async readiness() {
      return adapter.status === 'ready' ? 'ready' : adapter.status;
    },
    async page(partition, after, continuation, limit) {
      if (continuation !== null) throw new TypeError('Collection discovery does not use an opaque continuation');
      const page = await adapter.source.page(partition, after, limit);
      if (page.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', page.reason);
      return {
        position: BigInt(page.stamp.position),
        epoch: page.stamp.epoch,
        next: page.next,
        continuation: null,
        keys: page.items.map((item) => ({ owner: 'commerce', kind: 'collection', ...item.key })),
        records: collectionRecords(page.items),
      };
    },
    async read(partition, ids) {
      const keys = requestedKeys('commerce', 'collection', partition, ids);
      const snapshot = await adapter.source.read(
        partition,
        keys.map(({ route, id }) => ({ route, id })),
      );
      if (snapshot.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', snapshot.reason);
      return {
        position: BigInt(snapshot.stamp.position),
        epoch: snapshot.stamp.epoch,
        keys,
        records: collectionRecords(snapshot.items),
      };
    },
    async position(partition) {
      const snapshot = await adapter.source.read(partition, []);
      if (snapshot.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', snapshot.reason);
      return BigInt(snapshot.stamp.position);
    },
  };
}

function createReviewPopulationProducer(source: ReviewDiscoverySource | undefined): DiscoveryMetadataProducer {
  return {
    kind: 'review',
    owner: 'content',
    async readiness() {
      return source?.pageWithCut ? 'ready' : 'unavailable';
    },
    async page(partition, after, continuation, limit) {
      if (!source?.pageWithCut) throw new TypeError('Content review discovery pageWithCut capability is unavailable');
      if (continuation !== null && after === null)
        throw new TypeError('Review continuation has no native full-key frontier');
      const cursor = continuation === null ? null : { ...after!, token: continuation };
      const page = await source.pageWithCut(partition, cursor, Math.min(limit, REVIEW_DISCOVERY_PAGE_LIMIT));
      if (page.state === 'changed') throw new DiscoveryPopulationCutChangedError('review');
      if (page.state !== 'ready')
        throw new DiscoveryProducerCoverageError({
          missingKinds: [],
          unsupportedKinds: ['review'],
          duplicateKinds: [],
        });
      if (page.next && (typeof page.next.token !== 'string' || !page.next.token))
        throw new TypeError('Content review population returned an invalid opaque continuation');
      return {
        position: page.position,
        next: page.next ? { route: page.next.route, id: page.next.id } : null,
        continuation: page.next?.token ?? null,
        keys: page.reviews.map((review) => metadataKey('content', 'review', review.id)),
        records: reviewRecords(partition, page.position, page.reviews),
      };
    },
    async read(partition, ids) {
      if (!source) throw new TypeError('Content review discovery source is unavailable');
      const keys = requestedKeys('content', 'review', partition, ids);
      const snapshot = await source.read(partition, ids);
      return {
        position: snapshot.position,
        keys,
        records: reviewRecords(partition, snapshot.position, snapshot.reviews),
      };
    },
    async position(partition) {
      if (!source) throw new TypeError('Content review discovery source is unavailable');
      return (await source.read(partition, [])).position;
    },
  };
}

function createSpacePopulationProducer(
  adapter: SpaceDiscoveryAdapter,
): DiscoveryMetadataProducer {
  return {
    kind: 'space',
    owner: 'content',
    async readiness() {
      return adapter.source.dependencies();
    },
    async page(partition, after, continuation, limit) {
      if (continuation !== null) throw new TypeError('Space discovery does not use an opaque continuation');
      const page = await adapter.source.page(partition, after, limit);
      return {
        position: page.position,
        next: page.next,
        continuation: null,
        keys: page.spaces.map((space) => metadataKey('content', 'space', space.id)),
        records: spaceRecords(partition, page.spaces),
      };
    },
    async read(partition, ids) {
      const keys = requestedKeys('content', 'space', partition, ids);
      const snapshot = await adapter.source.read(partition, ids);
      return { position: snapshot.position, keys, records: spaceRecords(partition, snapshot.spaces) };
    },
    async position(partition) {
      return (await adapter.source.read(partition, [])).position;
    },
  };
}

/** Bind the delivered Commerce and Content leaves to the canonical current-reader slots. */
export type DiscoveryOwnerCompositionInput = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  clock?: KernelClock;
  collectionSource: CollectionDiscoverySource;
  reviewSource: ReviewDiscoverySource;
  space: SpaceDiscoveryAdapter;
}>;

export function createDiscoveryOwnerAdapters(config: DiscoveryOwnerCompositionInput): DiscoveryOwnerAdapters {
  const metadata = {
    collection: {
      id: 'collection',
      labels: {
        de: 'Sammlungen',
        en: 'Collections',
        es: 'Colecciones',
        fr: 'Collections',
        ja: 'コレクション',
        ko: '컬렉션',
        'zh-Hans': '收藏集',
        'zh-Hant': '收藏集',
      },
      icon: 'library',
    },
    review: {
      id: 'review',
      labels: {
        de: 'Rezensionen',
        en: 'Reviews',
        es: 'Reseñas',
        fr: 'Avis',
        ja: 'レビュー',
        ko: '리뷰',
        'zh-Hans': '评论',
        'zh-Hant': '評論',
      },
      icon: 'message-square',
    },
    space: {
      id: 'space',
      labels: {
        de: 'Spaces',
        en: 'Spaces',
        es: 'Espacios',
        fr: 'Espaces',
        ja: 'スペース',
        ko: '스페이스',
        'zh-Hans': '空间',
        'zh-Hant': '空間',
      },
      icon: 'users',
    },
  } as const;
  const clock = config.clock ? { clock: config.clock } : {};
  const collection = createNativeCollectionDiscoveryAdapter(
    { pool: config.pool, access: config.access, routeKey: config.routeKey, source: config.collectionSource, ...clock },
    metadata.collection,
  );
  const review = createReviewDiscoveryAdapter(config.reviewSource);
  const space = config.space;
  const ownerContext = (context: DiscoveryReadContext) => ({ deadline: context.deadline });
  const reviewSlot = review
    ? {
        readiness: 'ready' as const,
        adapter: {
          owner: 'content' as const,
          kind: 'review' as const,
          metadata: metadata.review,
          readCurrent: review.readCurrent,
        },
      }
    : { readiness: 'unavailable' as const };
  const spaceSlot = {
    readiness: 'ready' as const,
    adapter: {
      owner: 'content' as const,
      kind: 'space' as const,
      metadata: metadata.space,
      async readCurrent(
        ids: readonly string[],
        context: DiscoveryReadContext,
      ): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary<'space'>>> {
        if (!Array.isArray(ids) || ids.length > 200) throw new RangeError('Space current read exceeds 200 identities');
        const before = await space.source.dependencies();
        if (before.state !== 'ready')
          throw new DiscoveryProducerCoverageError({
            missingKinds: [],
            unsupportedKinds: ['space'],
            duplicateKinds: [],
          });
        const summaries = new Map<string, SpaceDiscoverySummary>();
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = await space.hydrate(ids.slice(offset, offset + 100), ownerContext(context));
          for (const [id, summary] of batch) summaries.set(id, summary);
        }
        const partitions = new Map<number, string[]>();
        for (const id of ids) {
          const route = routeOf(id);
          if (route === null) throw new TypeError('Invalid Space discovery identity');
          const partition = partitionOf(route);
          const group = partitions.get(partition) ?? [];
          group.push(id);
          partitions.set(partition, group);
        }
        const current = new Map<string, DiscoveryOwnerMetadataSummary<'space'>>();
        for (const [partition, group] of partitions) {
          for (let offset = 0; offset < group.length; offset += 100) {
            const batch = group.slice(offset, offset + 100);
            const snapshot = await space.source.read(partition, batch);
            for (const native of snapshot.spaces) {
              const summary = summaries.get(native.id);
              if (
                !summary ||
                summary.address !== native.address ||
                summary.title !== native.title ||
                summary.realmTitle !== native.realmTitle ||
                summary.realmId !== native.realmId ||
                summary.name !== native.name ||
                summary.description !== native.description
              )
                throw new TypeError('Current Space discovery presentation changed');
              current.set(native.id, {
                id: native.id,
                title: summary.title,
                summary: summary.description || null,
                revision: native.revision,
                sourcePosition: snapshot.position.toString(),
                address: summary.address,
                realmId: summary.realmId,
                realmTitle: summary.realmTitle,
              });
            }
          }
        }
        if (!isDeepStrictEqual(before, await space.source.dependencies()))
          throw new DiscoveryProducerCoverageError({
            missingKinds: [],
            unsupportedKinds: ['space'],
            duplicateKinds: [],
          });
        return current;
      },
    },
  };
  const metadataProducers: Readonly<Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>> = Object.freeze({
    collection: createCollectionPopulationProducer(collection),
    review: createReviewPopulationProducer(config.reviewSource),
    space: createSpacePopulationProducer(space),
  });
  return Object.freeze({
    collection: collection.registration,
    review: reviewSlot,
    space: spaceSlot,
    metadataProducers,
  });
}

