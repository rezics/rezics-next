import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { createWorkClient } from '../work/client.ts';
import type { ReviewDiscoverySource } from '../content/review-discovery.ts';
import type { Pool } from 'pg';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { createNativeCollectionDiscoveryAdapter } from './collection-discovery.ts';
import { createNativeReviewDiscoveryAdapter, createReviewDiscoveryAdapter } from './review-discovery.ts';
import { nativeSpaceDiscoveryAdapter } from './space-discovery.ts';
import type { DiscoveryOwnerAdapterSlots, DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from './discovery.ts';
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
import { discoveryConsumer } from './generations.ts';
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

/** Bind the delivered Commerce and Content leaves to the canonical current-reader slots. */
export function createDefaultDiscoveryOwnerAdapters(config: {
  pool: Pool;
  routeKey: Uint8Array;
  access: DefaultPublicFilterRuntimeConfig['access'];
  clock?: DefaultPublicFilterRuntimeConfig['clock'];
  keys?: KeyRing;
  reviewSource?: ReviewDiscoverySource;
}): DiscoveryOwnerAdapterSlots {
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
  const review = config.reviewSource
    ? createReviewDiscoveryAdapter(config.reviewSource)
    : config.keys
      ? createNativeReviewDiscoveryAdapter(
          { pool: config.pool, access: config.access, tokens: config.keys, ...clock },
          () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
        )
      : undefined;
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
  return Object.freeze({
    collection: collection.registration,
    review: reviewSlot,
    space: spaceSlot,
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
