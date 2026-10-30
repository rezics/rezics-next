import type { Pool } from 'pg';
import { createSearchGenerationPublication, type SearchGenerationPublication } from './generation-publication.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { ProblemError } from '../http/problem.ts';
import { createPublicSuggestionOperations, type PublicSuggestionOperations } from './public-suggestion.ts';
import { createPublicFilterConsumerOperations } from './public-filter-consumer.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicSuggestionCaptureInput,
} from './public-filter-consumer-contract.ts';
import { subjectGenerations, subjectIndexName } from './indices.ts';
import type { OpenSearch } from './opensearch.ts';

export type DefaultPublicFilterRuntimeConfig = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  search: OpenSearch;
  prefix: string;
  clock: KernelClock;
}>;
export type BoundPublicRequest = Readonly<{
  operations: PublicFilterConsumerOperations;
  capture: PublicFilterConsumerCapture;
}>;
export type DefaultPublicFilterRuntime = Readonly<{
  publication: SearchGenerationPublication;
  bindRequest(
    request: Readonly<{ plan: PublicFilterConsumerCaptureInput; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<BoundPublicRequest>;
  bindSuggestion(
    request: PublicSuggestionCaptureInput,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ operations: PublicSuggestionOperations; capture: PublicFilterConsumerCapture }>>;
  repair(
    job: PublicFilterConsumerJob,
    context: PublicFilterConsumerContext,
  ): ReturnType<PublicFilterConsumerOperations['repairStep']>;
  close(): Promise<void>;
}>;

function notReady(): never {
  throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}
function checkDeadline(context: PublicFilterConsumerContext): void {
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= Date.now())
    throw new ProblemError('deadline_exceeded');
}

/** Trusted default composition. Neither Source nor Actor nor physical identity is injectable. */
export function createDefaultPublicFilterRuntime(config: DefaultPublicFilterRuntimeConfig): DefaultPublicFilterRuntime {
  if (!(config.routeKey instanceof Uint8Array) || config.routeKey.byteLength !== 32)
    throw new TypeError('Public Search requires the canonical route key');
  const source = publicFilterSource(config);
  const publication = createSearchGenerationPublication({ ...config, source });
  const owned = new Set<{ close(): Promise<void> }>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new ProblemError('index_not_ready'));
    const promise = operation();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  async function create(
    physicalTarget: string,
    meaning: Pick<NonNullable<Awaited<ReturnType<typeof activeRelease>>>, 'digest' | 'release'>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerOperations> {
    checkDeadline(context);
    if (!meaning.release.types['schema:Thing']) notReady();
    const operations = await createPublicFilterConsumerOperations({
      pool: config.pool,
      source,
      search: config.search,
      clock: config.clock,
      context,
      physicalTarget,
      meaning: { digest: meaning.digest, release: meaning.release, type: 'schema:Thing' },
    });
    // Request-owned close also deregisters the factory; shutdown waits for admitted work first.
    owned.add(operations);
    let draining: Promise<void> | undefined;
    return {
      capture: operations.capture.bind(operations),
      query: operations.query.bind(operations),
      repairStep: operations.repairStep.bind(operations),
      readStatus: operations.readStatus.bind(operations),
      closeObservation: operations.closeObservation.bind(operations),
      close: () => (draining ??= operations.close().finally(() => owned.delete(operations))),
    };
  }
  return {
    publication,
    bindRequest(request, context) {
      return track(async () => {
        checkDeadline(context);
        const release = await activeRelease(config.pool);
        if (!release) notReady();
        const state = await subjectGenerations(config.search, config.prefix);
        if (state.active === null) notReady();
        if (request.plan.generation !== undefined && request.plan.generation !== state.active)
          throw new ProblemError('search_restart_required');
        const operations = await create(subjectIndexName(config.prefix, state.active), release, context);
        try {
          const capture = await operations.capture(structuredClone(request), context);
          checkDeadline(context);
          return { operations, capture };
        } catch (error) {
          await operations.close();
          throw error;
        }
      });
    },
    bindSuggestion(request, context) {
      return track(async () => {
        checkDeadline(context);
        const release = await activeRelease(config.pool);
        if (!release) notReady();
        const state = await subjectGenerations(config.search, config.prefix);
        if (state.active === null) notReady();
        if (request.generation !== undefined && request.generation !== state.active)
          throw new ProblemError('search_restart_required');
        const native = await createPublicSuggestionOperations({
          pool: config.pool,
          source,
          search: config.search,
          clock: config.clock,
          context,
          physicalTarget: subjectIndexName(config.prefix, state.active),
          meaning: { digest: release.digest, release: release.release, type: 'schema:Thing' },
        });
        owned.add(native);
        let draining: Promise<void> | undefined;
        const operations: PublicSuggestionOperations = {
          ...native,
          close: () => (draining ??= native.close().finally(() => owned.delete(native))),
        };
        try {
          const capture = await operations.capture(structuredClone({ ...request, generation: state.active }), context);
          checkDeadline(context);
          return { operations, capture };
        } catch (error) {
          await operations.close();
          throw error;
        }
      });
    },
    repair(job, context) {
      return track(async () => {
        checkDeadline(context);
        const digest = job.consumer.meaningDigest;
        const release = digest === null ? null : await readRelease(config.pool, digest);
        if (!release || digest === null) notReady();
        // The job only locates producer state. Native repair resolves incarnation, definition and grant again.
        const operations = await create(job.consumer.physicalTarget, { digest, release }, context);
        try {
          return await operations.repairStep(job, context);
        } finally {
          await operations.close();
        }
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([...owned].map((operations) => operations.close()));
        owned.clear();
        await publication.close();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })();
      return closing;
    },
  };
}
