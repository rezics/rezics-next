import { isDeepStrictEqual } from 'node:util';
import type { RetainedSearchContinuation } from './cursor.ts';
import type { SearchHit } from './query.ts';
import { advanceSearchRecovery } from './page-recovery.ts';
import { collectRetainedUsefulPage, type RetainedUsefulPage } from './useful-page.ts';
import type { Pool } from 'pg';
import { createSearchGenerationPublication, type SearchGenerationPublication } from './generation-publication.ts';
import type { Access } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { createSubjectSourceKeyPages } from '../semantic/subject-source-key-pages.ts';
import { createPublicFilterCustody } from './public-filter-custody.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import { subjectConsumer } from './runner.ts';
import type { PublicFilterConsumer } from '../semantic/public-filter-source-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { createPublicSuggestionOperations, type PublicSuggestionOperations } from './public-suggestion.ts';
import { createPublicFilterConsumerOperations } from './public-filter-consumer.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicDiscoveryConsumerOperations,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
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
  preparePublication(
    generation: number,
    context: PublicFilterConsumerContext,
  ): ReturnType<SearchGenerationPublication['prepare']>;
  bindRequest(
    request: Readonly<{ plan: PublicFilterConsumerCaptureInput; snapshot: 'pit' | 'prepared' }>,
    context: PublicFilterConsumerContext,
  ): Promise<BoundPublicRequest>;
  /** Reopen a factory for retained producer state without recapturing or resetting its allowance. */
  resumeRequest(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerOperations>;
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
  const binding = createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);
  const sourceKeys = createSubjectSourceKeyPages(config.pool, config.routeKey, config.access);
  const custody = createPublicFilterCustody(config.pool);
  const nativeSource = createRatedSubjectSource(config.pool, config.routeKey).source;
  const listing = subjectListingSource(config.pool);
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
  async function publicationFor(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext) {
    checkDeadline(context);
    const digest = consumer.meaningDigest;
    if (digest === null) notReady();
    const release = await readRelease(config.pool, digest);
    const match = /subjects-g([1-9][0-9]*)$/.exec(consumer.physicalTarget);
    const generation = Number(match?.[1]);
    if (
      !release ||
      !Number.isSafeInteger(generation) ||
      consumer.physicalTarget !== subjectIndexName(config.prefix, generation)
    )
      notReady();
    return createSearchGenerationPublication({
      pool: config.pool,
      search: config.search,
      source,
      sourceKeys,
      binding,
      clock: config.clock,
      meaning: { digest, release, type: 'schema:Thing' },
      writerGuard: createSearchWriterGuard({
        pool: config.pool,
        search: config.search,
        index: consumer.physicalTarget,
        consumer: subjectConsumer(config.prefix, generation),
        source: nativeSource,
        listing,
      }),
    });
  }
  const publication: SearchGenerationPublication = {
    prepare(consumer, context) {
      return track(async () => {
        const native = await publicationFor(consumer, context);
        try {
          return await native.prepare(consumer, context);
        } finally {
          await native.close();
        }
      });
    },
    step(job, context) {
      return track(async () => {
        const native = await publicationFor(job.consumer, context);
        try {
          return await native.step(job, context);
        } finally {
          await native.close();
        }
      });
    },
    activate(job, context) {
      return track(async () => {
        const native = await publicationFor(job.consumer, context);
        try {
          return await native.activate(job, context);
        } finally {
          await native.close();
        }
      });
    },
    async close() {
      await custody.close();
    },
  };
  async function create(
    physicalTarget: string,
    meaning: Pick<NonNullable<Awaited<ReturnType<typeof activeRelease>>>, 'digest' | 'release'>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicDiscoveryConsumerOperations> {
    checkDeadline(context);
    if (!meaning.release.types['schema:Thing']) notReady();
    const operations = await createPublicFilterConsumerOperations({
      pool: config.pool,
      source,
      binding,
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
      captureDiscovery: operations.captureDiscovery.bind(operations),
      queryDiscovery: operations.queryDiscovery.bind(operations),
      query: operations.query.bind(operations),
      repairStep: operations.repairStep.bind(operations),
      readStatus: operations.readStatus.bind(operations),
      closeObservation: operations.closeObservation.bind(operations),
      close: () => (draining ??= operations.close().finally(() => owned.delete(operations))),
    };
  }
  return {
    publication,
    preparePublication(generation, context) {
      return track(async () => {
        checkDeadline(context);
        const current = await activeRelease(config.pool);
        if (!current) notReady();
        const resolved = await binding.resolve(
          {
            source,
            meaning: { digest: current.digest, release: current.release, type: 'schema:Thing' },
            capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 1 },
          },
          context,
        );
        if (resolved.status !== 'resolved')
          return { status: resolved.status, reason: 'source_pending' as const, cost: resolved.cost };
        const registered = await custody.register(
          {
            definition: resolved.definition,
            physicalTarget: subjectIndexName(config.prefix, generation),
            consumerGeneration: String(generation),
            projectionGeneration: resolved.definition.readDefinition,
          },
          config.search,
          context,
        );
        if (registered.status !== 'registered')
          return { status: registered.status, reason: 'registration_missing' as const, cost: registered.cost };
        // Resolve native producer/registration evidence; never synthesize a queried observation or ACK.
        const native = await publicationFor(registered.consumer, context);
        try {
          return await native.prepare(registered.consumer, context);
        } finally {
          await native.close();
        }
      });
    },
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
    resumeRequest(queried, context) {
      return track(async () => {
        checkDeadline(context);
        const release = await activeRelease(config.pool);
        if (!release) notReady();
        const state = await subjectGenerations(config.search, config.prefix);
        if (state.active === null) notReady();
        if (
          queried.consumer.physicalTarget !== subjectIndexName(config.prefix, state.active) ||
          queried.consumer.meaningDigest !== release.digest
        )
          throw new ProblemError('search_restart_required');
        // Native query resolves incarnation, Source registration and the exact retained execution.
        return create(queried.consumer.physicalTarget, release, context);
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
          binding,
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

function readiness(): ProblemError {
  return new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}

function unavailable(result: PublicFilterConsumerUnavailable, continuing: boolean): never {
  if (continuing && (result.reason === 'incarnation_changed' || result.reason === 'observation_lost'))
    throw new ProblemError('search_restart_required');
  throw readiness();
}

function sameObservation(a: PublicFilterQueriedObservation, b: PublicFilterQueriedObservation): boolean {
  return (
    isDeepStrictEqual(a.consumer, b.consumer) &&
    a.snapshot.observation === b.snapshot.observation &&
    (a.snapshot.kind === 'pit'
      ? b.snapshot.kind === 'pit'
      : b.snapshot.kind === 'prepared' &&
        a.snapshot.build === b.snapshot.build &&
        a.snapshot.generation === b.snapshot.generation)
  );
}

export type PublicSearchRead<T> = Readonly<{
  page: RetainedUsefulPage<T>;
  continuation: RetainedSearchContinuation;
  /** Must follow ALL response/source/summary work, even on an exhausted empty page. */
  finalize: () => Promise<void>;
  /** Releases exhausted observations only, after final disclosure has completed. */
  release: () => Promise<void>;
}>;

/** Execute against ONE native captured observation, never against a live alias.
 * Native methods enforce SQL/point/byte/search ceilings across this root, including
 * final status. This layer additionally limits rounds and actual raw window work.
 */
export async function readPublicSearchPage<T>(options: {
  operations: PublicFilterConsumerOperations;
  plan: PublicFilterConsumerCaptureInput;
  context: PublicFilterConsumerContext;
  continuation?: RetainedSearchContinuation;
  /** The default runtime already performed the actual bound capture. */
  capture?: PublicFilterConsumerCapture;
  /** Existing durable preparation delivery, when installed by the host. */
  prepare?: (job: PublicFilterConsumerJob) => Promise<void>;
  /** A trusted planner choice. Prepared is the conservative default, not a claim of readiness. */
  snapshot?: 'pit' | 'prepared';
  check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
  canonicalId: (value: T) => string;
}): Promise<PublicSearchRead<T>> {
  const { operations, context, plan } = options;
  const limit = plan.pageSize;
  if (!Number.isInteger(limit) || limit === undefined || limit < 1 || limit > 100)
    throw new RangeError('A useful Search capture requires pageSize in 1..100');
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw readiness();
  const recover = async (job: PublicFilterConsumerJob): Promise<void> => {
    if (options.prepare) {
      await options.prepare(job);
      return;
    }
    const step = await advanceSearchRecovery(operations, job, context);
    if (step.status === 'unready' || step.status === 'unavailable')
      return unavailable(step, options.continuation !== undefined);
  };
  let queried: PublicFilterQueriedObservation;
  let repair: PublicFilterConsumerJob;
  if (options.continuation) {
    queried = options.continuation.queried;
    repair = options.continuation.repair;
  } else {
    const capture =
      options.capture ?? (await operations.capture({ plan, snapshot: options.snapshot ?? 'prepared' }, context));
    if (capture.status === 'captured') {
      queried = capture.queried;
      repair = capture.repair;
    } else if (capture.status === 'preparing') {
      await recover(capture.repair);
      // Settlement is diagnostic. Only a subsequent actual capture can be ready.
      throw readiness();
    } else return unavailable(capture, false);
  }
  const executions: string[] = [];
  const collect = (continuation?: RetainedSearchContinuation) =>
    collectRetainedUsefulPage({
      limit,
      prepared: queried.snapshot.kind === 'prepared',
      ...(continuation
        ? {
            continuation: continuation.window,
            spent: continuation.work,
            frontier: continuation.frontier,
          }
        : {}),
      read: async (_size, refill) => {
        const result = await operations.query(queried, context, refill);
        if (result.status === 'queried') {
          if (!sameObservation(queried, result.queried)) throw readiness();
          queried = result.queried;
          executions.push(result.execution);
          return { execution: result.execution, hits: result.result.hits, window: result.window };
        }
        if (result.status === 'preparing') {
          await recover(repair);
          throw readiness();
        }
        return unavailable(result, options.continuation !== undefined);
      },
      check: options.check,
      canonicalId: options.canonicalId,
    });
  let page = await collect(options.continuation);
  if (page.status === 'preparing') {
    // Do not hand the native owner a filtered vector or a guessed raw frontier.
    // Preparation restarts the unserved page from its last PUBLIC consumed tuple;
    // all partially collected values remain internal and are discarded.
    const preparing = await operations.capture({ plan, snapshot: 'prepared' }, context);
    if (!('repair' in preparing)) return unavailable(preparing, options.continuation !== undefined);
    if (
      preparing.status === 'captured' &&
      executions.length === 0 &&
      preparing.queried.snapshot.observation !== queried.snapshot.observation
    ) {
      if (!isDeepStrictEqual(queried.consumer, preparing.queried.consumer))
        throw new ProblemError('search_restart_required');
      // A later request that has spent no raw work can read the actual ready
      // replacement. This is a new prepared capture at the public page boundary,
      // not another direct reservation or a mutation of the old root.
      queried = preparing.queried;
      repair = preparing.repair;
      page = await collect();
    }
    if (page.status === 'preparing') {
      await recover(preparing.repair);
      // Even a captured build cannot be read after spending this request's allowance.
      throw readiness();
    }
  }
  const continuation: RetainedSearchContinuation = {
    queried,
    repair,
    window: page.continuation,
    frontier: page.frontier,
    work: { candidates: page.candidates, rounds: page.rounds },
    ...(plan.rating
      ? {
          rating: {
            questionId: plan.rating.questionId,
            populationId: plan.rating.populationId,
            priorEpoch: plan.rating.priorEpoch,
          },
        }
      : {}),
  };
  return {
    page,
    continuation,
    async finalize() {
      // End evidence never substitutes for final privacy authorization. Every
      // batch has its own retained start and original/terminal own-row set.
      for (const execution of executions) {
        const status = await operations.readStatus({ queried, execution }, context);
        if (status.status !== 'observed') return unavailable(status, options.continuation !== undefined);
        if (!sameObservation(queried, status.queried)) throw readiness();
        if (status.blocking.length !== 0) {
          await recover(repair);
          throw readiness();
        }
      }
    },
    async release() {
      if (page.status === 'exhausted') await operations.closeObservation(queried, context);
    },
  };
}
