import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { createWorkClient } from '../work/client.ts';
import { createReviewDiscoverySource, type ReviewDiscoverySource } from '../content/review-discovery.ts';
import type { Pool } from 'pg';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { CollectionDiscoveryReadinessError, createNativeCollectionDiscoveryAdapter } from './collection-discovery.ts';
import { createReviewDiscoveryAdapter } from './review-discovery.ts';
import { nativeSpaceDiscoveryAdapter } from './space-discovery.ts';
import type { DiscoveryOwnerAdapterSlots, DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from './discovery.ts';
import type { DiscoveryMetadataProducer, DiscoveryMetadataProducers } from './generations.ts';
import type { SecondScopeDiscoveryKey, SecondScopeDiscoveryRecord } from './discovery-documents.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import {
  createRetainedDiscoverySearch,
  type DiscoverySearch,
  type RetainedDiscoveryRead,
  type RetainedDiscoverySearch,
} from './discovery-service.ts';
import { ownDiscoveryRequest } from './discovery-request.ts';
import { createDefaultPublicFilterRuntime, type DefaultPublicFilterRuntimeConfig } from './public-runtime.ts';
import { createPublicPreparationStore } from './public-preparation-store.ts';
import { discoveryConsumer, DiscoveryProducerCoverageError } from './generations.ts';
import { discoveryIndexName } from './indices.ts';
import { readFreshness } from './freshness.ts';
import type { PublicDiscoveryConsumerOperations } from './public-filter-consumer-contract.ts';
import {
  installPublicFilterCoveragePage,
  openPublicFilterCoveragePage,
  type PublicFilterCoveragePage,
} from './public-filter-coverage-page.ts';

export type DefaultDiscoverySearchConfig = DefaultPublicFilterRuntimeConfig & { keys: KeyRing };
export type DefaultDiscoverySearch = Readonly<{
  search: DiscoverySearch;
  open: RetainedDiscoverySearch;
  close(): Promise<void>;
}>;

export type DefaultDiscoveryOwnerAdapters = DiscoveryOwnerAdapterSlots &
  Readonly<{ metadataProducers: DiscoveryMetadataProducers }>;

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
  items: readonly import('../library/collection-discovery-source.ts').CollectionDiscoveryItem[],
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
  reviews: readonly import('../content/review-discovery.ts').IndexedReview[],
) {
  const records: SecondScopeDiscoveryRecord[] = [];
  for (const review of reviews) {
    const key = metadataKey('content', 'review', review.id);
    if (partitionOf(key.route) !== partition) throw new TypeError('Review source returned a foreign partition key');
    if (typeof review.sourceVersion !== 'string' || !review.sourceVersion || !review.sourceVersion.isWellFormed())
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

function spaceRecords(partition: number, spaces: readonly import('../community/space-discovery.ts').IndexedSpace[]) {
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
      const page = await source.pageWithCut(partition, cursor, limit);
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
  adapter: ReturnType<typeof nativeSpaceDiscoveryAdapter>,
): DiscoveryMetadataProducer {
  return {
    kind: 'space',
    owner: 'content',
    async readiness() {
      const capability = await adapter.source.dependencies();
      return capability.state;
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
export function createDefaultDiscoveryOwnerAdapters(config: {
  pool: Pool;
  routeKey: Uint8Array;
  access: DefaultPublicFilterRuntimeConfig['access'];
  clock?: DefaultPublicFilterRuntimeConfig['clock'];
  keys?: KeyRing;
  reviewSource?: ReviewDiscoverySource;
}): DefaultDiscoveryOwnerAdapters {
  const metadata = {
    collection: { id: 'collection', labels: { en: 'Collections' }, icon: 'library' },
    review: { id: 'review', labels: { en: 'Reviews' }, icon: 'message-square' },
    space: { id: 'space', labels: { en: 'Spaces' }, icon: 'users' },
  } as const;
  const clock = config.clock ? { clock: config.clock } : {};
  const collection = createNativeCollectionDiscoveryAdapter(
    { pool: config.pool, access: config.access, routeKey: config.routeKey, ...clock },
    metadata.collection,
  );
  const reviewSource =
    config.reviewSource ??
    (config.keys
      ? createReviewDiscoverySource(
          { pool: config.pool, access: config.access, tokens: config.keys, ...clock },
          () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
        )
      : undefined);
  const review = reviewSource ? createReviewDiscoveryAdapter(reviewSource) : undefined;
  const space = nativeSpaceDiscoveryAdapter({ pool: config.pool, access: config.access, ...clock });
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
      ): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary>> {
        const summaries = await space.hydrate(ids, ownerContext(context));
        return new Map(
          [...summaries].map(([id, summary]) => [
            id,
            { id, title: summary.name, summary: summary.description || null },
          ]),
        );
      },
    },
  };
  const metadataProducers: DiscoveryMetadataProducers = Object.freeze({
    collection: createCollectionPopulationProducer(collection),
    review: createReviewPopulationProducer(reviewSource),
    space: createSpacePopulationProducer(space),
  });
  return Object.freeze({
    collection: collection.registration,
    review: reviewSlot,
    space: spaceSlot,
    metadataProducers,
  });
}

/** Default public catalogue/Account candidates, also consumed by the home feed with its current Actor.
 * Source owns whole-population readiness. Neither a local census nor returned summaries replace it.
 */
export function createDefaultDiscoverySearch(config: DefaultDiscoverySearchConfig): DefaultDiscoverySearch {
  const runtime = createDefaultPublicFilterRuntime(config);
  const source = publicFilterSource(config);
  const subjects = createRatedSubjectSource(config.pool, config.routeKey).source;
  const ownerAdapters = createDefaultDiscoveryOwnerAdapters(config);
  let work: ReturnType<typeof createWorkClient> | undefined;
  const pending = new Set<Promise<unknown>>();
  const retained = new Set<RetainedDiscoveryRead>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const open: RetainedDiscoverySearch = (principal, request, context) => {
    if (closed) return Promise.reject(new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } }));
    request = ownDiscoveryRequest(request);
    const deadline = context.deadline;
    const actor =
      context.actor.kind === 'account'
        ? Object.freeze({ ...context.actor, scopes: Object.freeze([...context.actor.scopes]) })
        : Object.freeze({ kind: 'anonymous' as const });
    const execute = async () => {
      let operations: PublicDiscoveryConsumerOperations | undefined;
      const current = await activeRelease(config.pool);
      if (!current) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      const registry = await nativeDiscoveryRegistry(config.pool, config.routeKey, subjects, {
        release: current.release,
        languages: request.languages ?? [],
        ownerAdapters,
      });
      const bound = () => {
        if (!operations) throw new Error('Discovery capture or retained resume must precede consumer work');
        return operations;
      };
      const consumer: PublicDiscoveryConsumerOperations = {
        capture: (input, nativeContext) => bound().capture(input, nativeContext),
        async captureDiscovery(input, nativeContext) {
          operations = await runtime.openDiscovery(registry, current.digest, nativeContext);
          return operations.captureDiscovery(input, nativeContext);
        },
        async queryDiscovery(queried, nativeContext, refill) {
          operations ??= await runtime.openDiscovery(registry, current.digest, nativeContext, queried);
          return operations.queryDiscovery(queried, nativeContext, refill);
        },
        query: (queried, nativeContext, refill) => bound().query(queried, nativeContext, refill),
        readStatus: (input, nativeContext) => bound().readStatus(input, nativeContext),
        repairStep: (job, nativeContext) => bound().repairStep(job, nativeContext),
        async closeObservation(queried, nativeContext) {
          // A rejected retained generation has not opened a factory in this request.
          if (operations) await operations.closeObservation(queried, nativeContext);
        },
        close: () => runtime.close(),
      };
      installPublicFilterCoveragePage(consumer, (nativeContext) => {
        let page: Promise<PublicFilterCoveragePage> | undefined;
        const open = (queried?: Parameters<typeof runtime.openDiscovery>[3]) =>
          (page ??= (async () => {
            operations ??= await runtime.openDiscovery(registry, current.digest, nativeContext, queried);
            return openPublicFilterCoveragePage(operations, nativeContext);
          })());
        return {
          capture: async (plan, snapshot) => (await open()).capture(plan, snapshot),
          query: async (queried, refill) => (await open(queried)).query(queried, refill),
          queryDiscovery: async (queried, refill) => (await open(queried)).queryDiscovery(queried, refill),
          consume: async (execution, consumed) => (await open()).consume(execution, consumed),
          async finish() {
            if (!page) throw new Error('Native page was not opened');
            await (await page).finish();
          },
          async dispose() {
            if (page) await (await page).dispose();
          },
          failure(error) {
            // The public discovery boundary translates native refusal after
            // this lazy wrapper has disposed its original resource owner.
            throw error;
          },
        };
      });
      const read = await createRetainedDiscoverySearch({
        consumer,
        source,
        keys: config.keys,
        now: () => config.clock().getTime(),
        resolve: async () => ({ ...current, registry }),
        async prepare(job) {
          // Enqueue on the existing durable default-worker path. No executor is launched by a request.
          work ??= createWorkClient(config.pool.options.connectionString ?? '', config.pool);
          await createPublicPreparationStore(config.pool, await work, config.prefix).retain(
            { kind: 'repair', key: JSON.stringify(job), job },
            Date.now() + 24 * 60 * 60 * 1000,
          );
        },
        async asOf(queried) {
          const match = /discovery-g([1-9][0-9]*)$/.exec(queried.consumer.physicalTarget);
          const generation = Number(match?.[1]);
          if (
            !Number.isSafeInteger(generation) ||
            discoveryIndexName(config.prefix, generation) !== queried.consumer.physicalTarget
          )
            throw new Error('Discovery freshness requires the actual queried mixed generation');
          return (await readFreshness(config.pool, discoveryConsumer(config.prefix, generation))).asOf.toISOString();
        },
      })(principal, request, { ...context, deadline, actor, access: config.access });
      const wrapped: RetainedDiscoveryRead = Object.freeze({
        search: () => read.search(),
        currentPrimaryCandidates: (keys) => read.currentPrimaryCandidates(keys),
        finish: () => read.finish(),
        async close() {
          try {
            await read.close();
          } finally {
            retained.delete(wrapped);
          }
        },
      });
      retained.add(wrapped);
      return wrapped;
    };
    const operation = execute().catch((error: unknown) => {
      if (error instanceof ProblemError) throw error;
      if (error instanceof CollectionDiscoveryReadinessError) throw error;
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const search: DiscoverySearch = (...args) => {
    const operation = (async () => {
      const read = await open(...args);
      try {
        const page = await read.search();
        await read.finish();
        return page;
      } finally {
        await read.close();
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  return {
    search,
    open,
    close() {
      closed = true;
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try {
          await Promise.allSettled([...retained].map((read) => read.close()));
          await runtime.close();
        } finally {
          if (work) await (await work).close();
        }
      })());
    },
  };
}
