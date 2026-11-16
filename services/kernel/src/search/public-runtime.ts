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
import type { SearchGenerationPublication } from './generation-publication.ts';
import type { Access } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import type { KernelClock } from '../clock.ts';
import { createPublicFilterCustody } from './public-filter-custody.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { subjectConsumer } from './runner.ts';
import type { PublicFilterConsumer } from '../semantic/public-filter-source-contract.ts';
import { ProblemError } from '../http/problem-error.ts';
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
import {
  subjectGenerations,
  subjectIndexName,
  readSubjectCalendarMappingFormat,
  readSubjectCreditMappingFormat,
} from './indices.ts';
import type { OpenSearch, SearchRequestOptions } from './opensearch.ts';
import type { CreditSearchSource } from './credit-search.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import { createFacetNativeOperations } from './facet-discovery-operations.ts';
import type { FacetAccessObservationPort } from './facet-access-port.ts';
import { createScopedFacetApplication } from './scoped-facet-application.ts';
import { createQueryPrivacyConsumer, type QueryPrivacyConsumer } from './query-privacy-consumer.ts';
import { searchSourcePublicationApplication } from './source-publication-application.ts';

export type DefaultPublicFilterRuntimeConfig = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  search: OpenSearch;
  prefix: string;
  clock: KernelClock;
  creditSearch?: CreditSearchSource;
  /** Composition-bound Access observation; omitted fixtures keep throwing through. */
  facetAccess?: FacetAccessObservationPort;
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
    acceptedRelease?: string,
  ): Promise<BoundPublicRequest>;
  /** Reopen a factory for retained producer state without recapturing or resetting its allowance. */
  resumeRequest(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    acceptedRelease?: string,
  ): Promise<PublicFilterConsumerOperations>;
  bindSuggestion(
    request: PublicSuggestionCaptureInput,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{ operations: PublicSuggestionOperations; capture: PublicFilterConsumerCapture }>>;
  repair(
    job: PublicFilterConsumerJob,
    context: PublicFilterConsumerContext,
  ): ReturnType<PublicFilterConsumerOperations['repairStep']>;
  /** Typed currentness and aggregate proofs over retained capture/query/repair. */
  privacy(operations: PublicFilterConsumerOperations): QueryPrivacyConsumer;
  /** Trusted native facet composition; omitted generation or meaning stays closed. */
  facetProvider(context?: PublicFilterConsumerContext): Promise<FacetDiscoveryProvider | undefined>;
  close(): Promise<void>;
}>;

function notReady(): never {
  throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}
function checkDeadline(context: PublicFilterConsumerContext): number {
  const remaining = context.deadline - Date.now();
  if (!Number.isSafeInteger(context.deadline) || remaining <= 0) throw new ProblemError('deadline_exceeded');
  return remaining;
}

/** Trusted default composition. Neither Source nor Actor nor physical identity is injectable. */
export function createDefaultPublicFilterRuntime(config: DefaultPublicFilterRuntimeConfig): DefaultPublicFilterRuntime {
  const scopedFacets = createScopedFacetApplication({
    ...(config.facetAccess === undefined ? {} : { access: config.facetAccess }),
  }).source;
  const sourcePublication = searchSourcePublicationApplication();
  type ActiveRelease = NonNullable<Awaited<ReturnType<typeof sourcePublication.activeRelease>>>;
  async function requestMeaning(context: PublicFilterConsumerContext, acceptedRelease?: string) {
    checkDeadline(context);
    // Native release reads own their short snapshot on the original pool and inherit
    // this absolute deadline, including physical checkout and transaction settlement.
    const meaning = await withRequestDeadline(context.deadline, async () => {
      if (acceptedRelease === undefined) return sourcePublication.activeRelease(config.pool);
      const release = await sourcePublication.readRelease(config.pool, acceptedRelease);
      return release ? { digest: acceptedRelease, release } : null;
    });
    checkDeadline(context);
    return meaning;
  }
  function requestSearch(context: PublicFilterConsumerContext): OpenSearch {
    return {
      ...config.search,
      async request<T>(
        method: Parameters<OpenSearch['request']>[0],
        path: string,
        body?: unknown,
        options?: SearchRequestOptions,
      ) {
        const remaining = checkDeadline(context);
        const response = await config.search.request<T>(method, path, body, {
          ...options,
          timeoutMs: Math.min(options?.timeoutMs ?? Infinity, remaining),
        });
        checkDeadline(context);
        return response;
      },
    };
  }
  if (!(config.routeKey instanceof Uint8Array) || config.routeKey.byteLength !== 32)
    throw new TypeError('Public Search requires the canonical route key');
  const source = sourcePublication.publicFilterSource(config);
  const binding = sourcePublication.createPublicFilterSourceBinding(config.pool, config.routeKey, config.access);
  const sourceKeys = sourcePublication.createSubjectSourceKeyPages(config.pool, config.routeKey, config.access);
  const custody = createPublicFilterCustody(config.pool);
  const nativeSource = createRatedSubjectSource(config.pool, config.routeKey, config.creditSearch).source;
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
  let cleanupFailure: { error: unknown } | undefined;
  let publicationBindingFailure: string | undefined;
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new ProblemError('index_not_ready'));
    const promise = operation();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  function retire(factory: Promise<{ close(): Promise<void> }>): void {
    // Factory cleanup can drain other requests. Keep it runtime-owned without
    // extending the request that observed a replacement or a failed capture.
    const drain = factory.then(
      (operations) => operations.close(),
      () => {},
    );
    pending.add(drain);
    void drain.then(
      () => pending.delete(drain),
      (error: unknown) => {
        pending.delete(drain);
        cleanupFailure ??= { error };
      },
    );
  }
  async function publicationFor(consumer: PublicFilterConsumer, context: PublicFilterConsumerContext) {
    checkDeadline(context);
    const digest = consumer.meaningDigest;
    if (digest === null) notReady();
    const release = (await requestMeaning(context, digest))?.release;
    const match = /subjects-g([1-9][0-9]*)$/.exec(consumer.physicalTarget);
    const generation = Number(match?.[1]);
    if (
      !release ||
      !Number.isSafeInteger(generation) ||
      consumer.physicalTarget !== subjectIndexName(config.prefix, generation)
    )
      notReady();
    const search = requestSearch(context);
    await readSubjectCalendarMappingFormat(search, config.prefix, generation);
    await readSubjectCreditMappingFormat(search, config.prefix, generation);
    return sourcePublication.createGenerationPublication({
      pool: config.pool,
      search: config.search,
      source,
      sourceKeys,
      clock: config.clock,
      meaning: { digest, release },
      binding,
      writer: {
        index: consumer.physicalTarget,
        consumer: subjectConsumer(config.prefix, generation),
        source: nativeSource,
        listing,
      },
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
    step(job, context, options) {
      return track(async () => {
        const native = await publicationFor(job.consumer, context);
        try {
          return await native.step(job, context, options);
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
    meaning: Pick<ActiveRelease, 'digest' | 'release'>,
    context: PublicFilterConsumerContext,
    registry?: DiscoveryRegistry,
  ): Promise<PublicDiscoveryConsumerOperations> {
    checkDeadline(context);
    const operations = await createPublicFilterConsumerOperations({
      pool: config.pool,
      source,
      ...(config.creditSearch === undefined ? {} : { creditSearch: config.creditSearch }),
      binding,
      search: config.search,
      clock: config.clock,
      context,
      physicalTarget,
      meaning: { digest: meaning.digest, release: meaning.release },
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
    const handle: PublicDiscoveryConsumerOperations = {
      capture: operations.capture.bind(operations),
      captureDiscovery: operations.captureDiscovery.bind(operations),
      queryDiscovery: operations.queryDiscovery.bind(operations),
      query: operations.query.bind(operations),
      repairStep: operations.repairStep.bind(operations),
      readStatus: operations.readStatus.bind(operations),
      closeObservation: operations.closeObservation.bind(operations),
      close: async () => {},
    };
    // Request cleanup does not own the shared factory, but the request still uses
    // its exact capture, meter and native START/FINAL page. Forward the private
    // opener through every handle, including handles reopened for continuations.
    forwardPublicFilterCoveragePage(operations, handle);
    return handle;
  }
  async function subjectOperations(
    physicalTarget: string,
    meaning: Pick<ActiveRelease, 'digest' | 'release'>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicDiscoveryConsumerOperations> {
    checkDeadline(context);
    const key = JSON.stringify([physicalTarget, meaning.digest]);
    let operations = subjects.get(key);
    if (!operations) {
      operations = create(physicalTarget, meaning, context);
      subjects.set(key, operations);
      void operations.catch(() => {
        if (subjects.get(key) === operations) subjects.delete(key);
      });
    }
    checkDeadline(context);
    // Saved rules can read an older accepted meaning while ordinary Search reads the active one.
    // Closing that meaning's factory would close its retained observations and break continuation.
    const retired = [...subjects].filter(
      ([candidate]) => (JSON.parse(candidate) as [string, string])[0] !== physicalTarget,
    );
    for (const [candidate, old] of retired) {
      subjects.delete(candidate);
      retire(old);
    }
    const current = await operations;
    checkDeadline(context);
    return current;
  }
  return {
    openDiscovery(registry, digest, context, queried) {
      return track(async () => {
        checkDeadline(context);
        const release = await requestMeaning(context);
        if (!release) notReady();
        if (release.digest !== digest) throw new ProblemError('search_restart_required');
        const result = await withBoundedReadConnection(
          config.pool,
          context.deadline,
          (client) =>
            client.query<{ generation: number; uuid: string; incarnation: string }>({
              text: `SELECT generation::float8 AS generation,index_uuid AS uuid,incarnation::text
                FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND state='active'`,
              values: [config.prefix],
            }),
          {
            deadlineError: () => new ProblemError('deadline_exceeded'),
            isUncertainSettledQueryError: () => true,
          },
        );
        checkDeadline(context);
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
        checkDeadline(context);
        // A real generation/release switch invalidates old cursors. Drain their factories rather
        // than retaining one resource owner for every historical release in a long-lived process.
        const retired = [...mixed].filter(([candidate]) => candidate !== key);
        for (const [candidate, old] of retired) {
          mixed.delete(candidate);
          retire(old);
        }
        const current = await operations;
        checkDeadline(context);
        return current;
      });
    },
    publication,
    preparePublication(generation, context) {
      return track(async () => {
        checkDeadline(context);
        const current = await requestMeaning(context);
        if (!current) notReady();
        const resolved = await binding.resolve(
          {
            source,
            meaning: { digest: current.digest, release: current.release },
            capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 1 },
          },
          context,
        );
        if (resolved.status !== 'resolved') {
          const failure = `${generation}:${resolved.status}:${resolved.reason}`;
          if (publicationBindingFailure !== failure) {
            publicationBindingFailure = failure;
            console.warn(
              JSON.stringify({
                event: 'search.public_preparation.source_binding',
                prefix: config.prefix,
                generation,
                status: resolved.status,
                reason: resolved.reason,
              }),
            );
          }
          return {
            status: resolved.status,
            reason: resolved.reason === 'deadline' ? ('deadline' as const) : ('source_pending' as const),
            cost: resolved.cost,
          };
        }
        publicationBindingFailure = undefined;
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
    bindRequest(request, context, acceptedRelease) {
      return track(async () => {
        checkDeadline(context);
        const release = await requestMeaning(context, acceptedRelease);
        if (!release) notReady();
        const state = await subjectGenerations(requestSearch(context), config.prefix);
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
    resumeRequest(queried, context, acceptedRelease) {
      return track(async () => {
        checkDeadline(context);
        const release = await requestMeaning(context, acceptedRelease);
        if (!release) notReady();
        const state = await subjectGenerations(requestSearch(context), config.prefix);
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
        const release = await requestMeaning(context);
        if (!release) notReady();
        const state = await subjectGenerations(requestSearch(context), config.prefix);
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
          meaning: { digest: release.digest, release: release.release },
        });
        owned.add(native);
        let draining: Promise<void> | undefined;
        const operations: PublicSuggestionOperations = {
          ...native,
          close: () => (draining ??= native.close().finally(() => owned.delete(native))),
        };
        try {
          checkDeadline(context);
          const capture = await operations.capture(structuredClone({ ...request, generation: state.active }), context);
          checkDeadline(context);
          return { operations, capture };
        } catch (error) {
          retire(Promise.resolve(operations));
          throw error;
        }
      });
    },
    privacy(operations) {
      return createQueryPrivacyConsumer(operations);
    },
    repair(job, context) {
      return track(async () => {
        checkDeadline(context);
        const digest = job.consumer.meaningDigest;
        const release = digest === null ? null : (await requestMeaning(context, digest))?.release;
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
    facetProvider(context = { deadline: deadlineFor(30_000) }) {
      return track(async () => {
        // Bound acquisition only; retained operations below receive each later caller's context.
        const acquisition = {
          ...context,
          deadline: Math.min(context.deadline, deadlineFor(checkDeadline(context))),
        };
        const current = await requestMeaning(acquisition);
        const state = await subjectGenerations(requestSearch(acquisition), config.prefix);
        checkDeadline(acquisition);
        const generation = state.active;
        if (!current || generation === null) return undefined;
        const physicalTarget = subjectIndexName(config.prefix, generation);
        const meaning = { digest: current.digest, release: current.release };
        const provider = {
          source: config.prefix,
          meaning,
          generation,
          operations: createFacetNativeOperations({
            pool: config.pool,
            routeKey: config.routeKey,
            access: config.access,
            search: config.search,
            clock: config.clock,
            source,
            binding,
            subjects: nativeSource,
            scopedFacets,
            query: async (queried, context) =>
              (await subjectOperations(physicalTarget, current, context)).query(queried, context),
            capture: async (plan, snapshot, context) => {
              const handle = await subjectOperations(physicalTarget, current, context);
              return handle.capture({ plan: { ...plan, generation }, snapshot }, context);
            },
            async repair(job, context) {
              const digest = job.consumer.meaningDigest;
              const release = digest === null ? null : (await requestMeaning(context, digest))?.release;
              if (!release || digest === null) notReady();
              return (await subjectOperations(job.consumer.physicalTarget, { digest, release }, context)).repairStep(
                job,
                context,
              );
            },
          }),
        };
        checkDeadline(acquisition);
        return provider;
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([...pending, ...[...owned].map((operations) => operations.close())]);
        mixed.clear();
        subjects.clear();
        owned.clear();
        await publication.close();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (cleanupFailure) throw cleanupFailure.error;
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
