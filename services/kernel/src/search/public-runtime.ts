import { isDeepStrictEqual } from 'node:util';
import { forwardPublicFilterCoveragePage, openPublicFilterCoveragePage } from './public-filter-coverage-page.ts';
import type { RetainedSearchContinuation } from './cursor.ts';
import type { SearchHit } from './query.ts';
import { advanceSearchRecovery } from './page-recovery.ts';
import { collectRetainedUsefulPage, type RetainedUsefulPage } from './useful-page.ts';
import type { Pool } from 'pg';
import type { DiscoveryRegistry } from './discovery.ts';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { discoveryIndexName } from './indices.ts';
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
  /** Pins the active mixed physical allocation; retained roots must still address that allocation. */
  openDiscovery(
    registry: DiscoveryRegistry,
    digest: string,
    context: PublicFilterConsumerContext,
    queried?: PublicFilterQueriedObservation,
  ): Promise<PublicDiscoveryConsumerOperations>;
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
  // Mixed factories retain PIT ownership until exhaustion or runtime shutdown. Reusing the
  // active factory avoids closing signed continuations at the end of their HTTP request.
  const mixed = new Map<string, Promise<PublicDiscoveryConsumerOperations>>();
  // Subject factories use the same native close contract. The runtime retains one current
  // factory so request cleanup cannot drain a continuation or a bounded repair.
  const subjects = new Map<string, Promise<PublicDiscoveryConsumerOperations>>();
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
    registry?: DiscoveryRegistry,
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
      ...(registry === undefined ? {} : { registry }),
    });
    // Native factory close drains owned observations; shutdown and replacement use this wrapper.
    owned.add(operations);
    let draining: Promise<void> | undefined;
    const wrapper: PublicDiscoveryConsumerOperations = {
      capture: operations.capture.bind(operations),
      captureDiscovery: operations.captureDiscovery.bind(operations),
      queryDiscovery: operations.queryDiscovery.bind(operations),
      query: operations.query.bind(operations),
      repairStep: operations.repairStep.bind(operations),
      readStatus: operations.readStatus.bind(operations),
      closeObservation: operations.closeObservation.bind(operations),
      close: () => (draining ??= operations.close().finally(() => owned.delete(operations))),
    };
    forwardPublicFilterCoveragePage(operations, wrapper);
    return wrapper;
  }
  function requestHandle(operations: PublicDiscoveryConsumerOperations): PublicDiscoveryConsumerOperations {
    return {
      capture: operations.capture.bind(operations),
      captureDiscovery: operations.captureDiscovery.bind(operations),
      queryDiscovery: operations.queryDiscovery.bind(operations),
      query: operations.query.bind(operations),
      repairStep: operations.repairStep.bind(operations),
      readStatus: operations.readStatus.bind(operations),
      closeObservation: operations.closeObservation.bind(operations),
      close: async () => {},
    };
  }
  async function subjectOperations(
    physicalTarget: string,
    meaning: Pick<NonNullable<Awaited<ReturnType<typeof activeRelease>>>, 'digest' | 'release'>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicDiscoveryConsumerOperations> {
    const key = JSON.stringify([physicalTarget, meaning.digest]);
    let operations = subjects.get(key);
    if (!operations) {
      operations = create(physicalTarget, meaning, context);
      subjects.set(key, operations);
      void operations.catch(() => {
        if (subjects.get(key) === operations) subjects.delete(key);
      });
    }
    const retired = [...subjects].filter(([candidate]) => candidate !== key);
    for (const [candidate, old] of retired) {
      subjects.delete(candidate);
      await (await old).close();
    }
    return operations;
  }
  return {
    openDiscovery(registry, digest, context, queried) {
      return track(async () => {
        checkDeadline(context);
        const release = await activeRelease(config.pool);
        if (!release) notReady();
        if (release.digest !== digest) throw new ProblemError('search_restart_required');
        const query: import('pg').QueryConfig & { query_timeout: number } = {
          text: `SELECT generation::float8 AS generation,index_uuid AS uuid,incarnation::text
            FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND state='active'`,
          values: [config.prefix],
          query_timeout: Math.max(1, context.deadline - Date.now()),
        };
        const result = await config.pool.query<{ generation: number; uuid: string; incarnation: string }>(query);
        if (result.rows.length !== 1) notReady();
        const allocation = result.rows[0]!;
        if (!allocation.uuid || !Number.isSafeInteger(allocation.generation)) notReady();
        const target = discoveryIndexName(config.prefix, allocation.generation);
        if (
          queried &&
          (queried.consumer.physicalTarget !== target ||
            queried.consumer.incarnation !== allocation.uuid ||
            queried.consumer.meaningDigest !== digest)
        )
          throw new ProblemError('search_restart_required');
        const key = JSON.stringify([target, allocation.uuid, allocation.incarnation, digest]);
        let operations = mixed.get(key);
        if (!operations) {
          operations = create(target, release, context, registry);
          mixed.set(key, operations);
          void operations.catch(() => {
            if (mixed.get(key) === operations) mixed.delete(key);
          });
        }
        // A real generation/release switch invalidates old cursors. Drain their factories rather
        // than retaining one resource owner for every historical release in a long-lived process.
        const retired = [...mixed].filter(([candidate]) => candidate !== key);
        for (const [candidate, old] of retired) {
          mixed.delete(candidate);
          await (await old).close();
        }
        return operations;
      });
    },
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
        const operations = requestHandle(
          await subjectOperations(subjectIndexName(config.prefix, state.active), release, context),
        );
        const capture = await operations.capture(structuredClone(request), context);
        checkDeadline(context);
        return { operations, capture };
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
        return requestHandle(await subjectOperations(queried.consumer.physicalTarget, release, context));
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
        const registry = job.consumer.physicalTarget.startsWith(`${config.prefix}discovery-g`)
          ? await nativeDiscoveryRegistry(config.pool, config.routeKey, nativeSource, { release })
          : undefined;
        if (registry) {
          const operations = await create(job.consumer.physicalTarget, { digest, release }, context, registry);
          try {
            return await operations.repairStep(job, context);
          } finally {
            await operations.close();
          }
        }
        return (await subjectOperations(job.consumer.physicalTarget, { digest, release }, context)).repairStep(
          job,
          context,
        );
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([...owned].map((operations) => operations.close()));
        mixed.clear();
        subjects.clear();
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
  /** Always called by the response owner, including hydration/cursor/final failures. */
  dispose: () => Promise<void>;
}>;

/** Execute against ONE native captured observation, never against a live alias.
 * Native methods enforce SQL/point/byte/search ceilings across this root, including
 * final authority. This layer additionally limits rounds and actual raw window work.
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
  let captured: Extract<PublicFilterConsumerCapture, { status: 'captured' }> | undefined;
  let previous = options.continuation;
  if (previous) {
    queried = previous.queried;
    repair = previous.repair;
    const prepared = queried.snapshot.kind === 'prepared';
    const candidateLimit = prepared ? 2 * limit + 2 : Math.min(600, 6 * limit + 3);
    const roundLimit = prepared ? 2 : 3;
    if (
      !Number.isInteger(previous.work.rounds) ||
      previous.work.rounds < 0 ||
      previous.work.rounds > roundLimit ||
      !Number.isInteger(previous.work.candidates) ||
      previous.work.candidates < 0 ||
      previous.work.candidates > candidateLimit
    )
      throw new RangeError('Invalid retained Search allowance');
    if (previous.work.rounds === roundLimit || previous.work.candidates === candidateLimit) {
      // No current root or dispatch exists yet. A spent prior continuation can
      // select only an actual prepared replacement, with its own native enrollment;
      // it cannot reset a live root or rewrite the previous observation's cut.
      const replacement = await operations.capture({ plan, snapshot: 'prepared' }, context);
      if (replacement.status !== 'captured') {
        if (replacement.status === 'preparing') await recover(replacement.repair);
        else return unavailable(replacement, true);
        throw readiness();
      }
      if (!isDeepStrictEqual(queried.consumer, replacement.queried.consumer))
        throw new ProblemError('search_restart_required');
      if (queried.snapshot.observation === replacement.queried.snapshot.observation) {
        await recover(replacement.repair);
        throw readiness();
      }
      captured = replacement;
      queried = replacement.queried;
      repair = replacement.repair;
      previous = undefined;
    }
  } else {
    const capture =
      options.capture ?? (await operations.capture({ plan, snapshot: options.snapshot ?? 'prepared' }, context));
    if (capture.status === 'captured') {
      captured = capture;
      queried = capture.queried;
      repair = capture.repair;
    } else if (capture.status === 'preparing') {
      await recover(capture.repair);
      // Settlement is diagnostic. Only a subsequent actual capture can be ready.
      throw readiness();
    } else return unavailable(capture, false);
  }
  const coverage = (() => {
    try {
      return openPublicFilterCoveragePage(operations, context, captured);
    } catch {
      // Missing native composition or a capture from another owner is unavailable.
      throw readiness();
    }
  })();
  const dispose = async () => {
    try {
      await coverage.dispose();
    } catch (error) {
      return unavailable(coverage.failure(error), options.continuation !== undefined);
    }
  };
  try {
    const page = await collectRetainedUsefulPage({
      limit,
      prepared: queried.snapshot.kind === 'prepared',
      ...(previous
        ? {
            continuation: previous.window,
            spent: previous.work,
            frontier: previous.frontier,
          }
        : {}),
      read: async (_size, refill) => {
        const result = await coverage.query(queried, refill);
        if (result.status === 'queried') {
          if (!sameObservation(queried, result.queried)) throw readiness();
          queried = result.queried;
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
      consume: ({ execution, consumed }) => coverage.consume(execution, consumed),
    });
    if (page.status === 'preparing') {
      // This unserved root owns every attempted child. Preparation cannot replace
      // its observation or grant a fresh allowance inside the same response.
      await recover(repair);
      throw readiness();
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
    let finalized = false;
    return {
      page,
      continuation,
      async finalize() {
        // One current role verifies the entire native child/own-row chain after
        // owner hydration, metadata, response/cursor and as_of construction.
        try {
          await coverage.finish();
        } catch (error) {
          return unavailable(coverage.failure(error), options.continuation !== undefined);
        }
        finalized = true;
      },
      async release() {
        if (!finalized) throw readiness();
        await dispose();
        if (page.status === 'exhausted') {
          try {
            await operations.closeObservation(queried, context);
          } catch (error) {
            return unavailable(coverage.failure(error), options.continuation !== undefined);
          }
        }
      },
      dispose,
    };
  } catch (error) {
    try {
      await coverage.dispose();
    } catch {
      // Preserve the serving failure. Native failed/pending custody is retained
      // when cleanup itself cannot finish within the original frame.
    }
    return unavailable(coverage.failure(error), options.continuation !== undefined);
  }
}
