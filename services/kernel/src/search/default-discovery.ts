import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { createWorkClient } from '../work/client.ts';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import { createDiscoverySearch, type DiscoverySearch } from './discovery-service.ts';
import { createDefaultPublicFilterRuntime, type DefaultPublicFilterRuntimeConfig } from './public-runtime.ts';
import { createPublicPreparationStore } from './public-preparation-store.ts';
import { discoveryConsumer } from './generations.ts';
import { discoveryIndexName } from './indices.ts';
import { readFreshness } from './freshness.ts';
import type { PublicDiscoveryConsumerOperations } from './public-filter-consumer-contract.ts';

export type DefaultDiscoverySearchConfig = DefaultPublicFilterRuntimeConfig & { keys: KeyRing };
export type DefaultDiscoverySearch = Readonly<{ search: DiscoverySearch; close(): Promise<void> }>;

/** Default public catalogue/Account candidates, also consumed by the home feed with its current Actor.
 * Source owns whole-population readiness. Neither a local census nor returned summaries replace it.
 */
export function createDefaultDiscoverySearch(config: DefaultDiscoverySearchConfig): DefaultDiscoverySearch {
  const runtime = createDefaultPublicFilterRuntime(config);
  const source = publicFilterSource(config);
  const subjects = createRatedSubjectSource(config.pool, config.routeKey).source;
  let work: ReturnType<typeof createWorkClient> | undefined;
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const search: DiscoverySearch = (principal, request, context) => {
    if (closed) return Promise.reject(new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } }));
    const execute = async () => {
      let operations: PublicDiscoveryConsumerOperations | undefined;
      const current = await activeRelease(config.pool);
      if (!current) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      const registry = await nativeDiscoveryRegistry(config.pool, config.routeKey, subjects, {
        release: current.release,
        languages: request.languages,
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
      return createDiscoverySearch({
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
          if (!Number.isSafeInteger(generation) ||
            discoveryIndexName(config.prefix, generation) !== queried.consumer.physicalTarget)
            throw new Error('Discovery freshness requires the actual queried mixed generation');
          return (await readFreshness(config.pool, discoveryConsumer(config.prefix, generation))).asOf.toISOString();
        },
      })(principal, request, { ...context, access: config.access });
    };
    const operation = execute().catch((error: unknown) => {
      if (error instanceof ProblemError) throw error;
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  return {
    search,
    close() {
      closed = true;
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try { await runtime.close(); } finally { if (work) await (await work).close(); }
      })());
    },
  };
}
