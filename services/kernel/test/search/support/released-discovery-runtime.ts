import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Access } from '../../../src/request/access.ts';
import { composeSearchSemanticSource } from '../../../src/composition/search-semantic.ts';
import {
  createDefaultPublicFilterRuntime,
  type DefaultPublicFilterRuntime,
} from '../../../src/search/public-runtime.ts';
import type { PublicFilterConsumerOperations } from '../../../src/search/public-filter-consumer-contract.ts';
import { createPublicPreparationStore, type PreparationRecord } from '../../../src/search/public-preparation-store.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';
import { createOutcomeWorker, type WorkerStats } from './outcome-worker.ts';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import type { createKernel } from '../../../src/http/kernel.ts';
import { subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError, SearchUnavailableError } from '../../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, HIT_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../../src/search/query.ts';
import { createSearchService } from '../../../src/search/service.ts';
import { readFreshness } from '../../../src/search/freshness.ts';
import { subjectConsumer } from '../../../src/search/runner.ts';
import { createRatedSubjectSource } from '../../../src/search/rated-source.ts';
import { createWorkClient, type WorkClient } from '../../../src/work/client.ts';
import { systemClock } from '../../../src/clock.ts';
import type { SemanticOutcomeDriver } from '../../semantic/outcome-driver.ts';
import type { CreatedSubject } from '../../support/released-discovery.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { outcomeClockInstant, startOutcomeWorkerProcess } from './outcome-rpc.ts';
import { searchProxy } from './outcome-supervisor.ts';
import { searchWorkerOwnership, type SearchWorkerKind } from './runner-slot.ts';

type Request = (path: string, body?: unknown) => Promise<HttpResponse>;
/** The production factories and their returned operations retain all native admission and custody. */
export type ReleasedNativeConsumers = Pick<
  DefaultPublicFilterRuntime,
  'bindRequest' | 'resumeRequest' | 'repair' | 'preparePublication'
>;
export type ReleasedNativeObservation = Pick<
  PublicFilterConsumerOperations,
  'capture' | 'query' | 'repairStep' | 'readStatus' | 'closeObservation' | 'close'
>;
export type ReleasedNativeBoundRequest = Awaited<ReturnType<DefaultPublicFilterRuntime['bindRequest']>>;
export type ReleasedNativeRepairJob = Parameters<DefaultPublicFilterRuntime['repair']>[0];
/** Explicit pool instrumentation requires the actual parent-process SDK and pool identities. */
export type ReleasedDiscoveryWorkerKind = SearchWorkerKind;
export type ReleasedTransportBarrier = Readonly<{
  /** Resolves only when real I/O reaches the selected transport boundary. */
  reached: Promise<void>;
  release(): void;
}>;
export type ReleasedTransportBoundary = Readonly<{
  phase: 'request' | 'response';
  method: Parameters<OpenSearch['request']>[0];
  /** Exact native HTTP path, with no query/source/owner predicate. */
  path: string;
}>;
export interface ReleasedDiscoveryRuntime extends ReleasedNativeConsumers {
  /** Diagnostic transport address only; never consumer or job authority. */
  readonly indexPrefix: string;
  /** Instrumentation is observable and cannot be mistaken for process-kill evidence. */
  readonly workerKind: ReleasedDiscoveryWorkerKind;
  indexing(state: 'paused' | 'running'): Promise<void>;
  converge(subjects: readonly CreatedSubject[]): Promise<void>;
  rebuild(): Promise<{ generation: number; previous: number | null }>;
  barrier(boundary: ReleasedTransportBoundary): ReleasedTransportBarrier;
  /** Read the current native consumer's PostgreSQL lag; conveys no Source readiness. */
  freshness(): Promise<import('../../../src/search/freshness.ts').Freshness>;
  /** Optional owner expiry applies to this retain only; the default remains exactly 24 hours. */
  preparePublic(job: ReleasedNativeRepairJob, options?: Readonly<{ expiresAt: number }>): Promise<string>;
  readPreparation(id: string): Promise<PreparationRecord | null>;
  workerStats(): Promise<WorkerStats>;
  crash(): Promise<{ code: number | null; signal: string | null }>;
  restart(): Promise<WorkerStats>;
}

/** Internal shared-fixture handoff; Access is supplied once by the installed Kernel. */
export interface ReleasedDiscoveryComposition {
  control: ReleasedDiscoveryRuntime;
  /** Explicit shared-fixture freeze/advance only; receives the actual cloned fixture instant. */
  onClockChange(instant: Date): void;
  /** Acknowledge all earlier clock transitions before a dependent Kernel request. */
  flushClock(): Promise<void>;
  onAccessReady(access: Access): void;
  service(installed: Parameters<typeof createKernel>[0]): ReturnType<typeof createSearchService>;
  start(runtime: SemanticOutcomeDriver['fixtures']['runtime'], send: Request): Promise<void>;
  close(): Promise<void>;
}

/** One native prefix and one default SDK, with explicit pool instrumentation kept in-process. */
export function releasedDiscoveryRuntime(
  kernelPool?: (url: string) => Pool | Promise<Pool>,
): ReleasedDiscoveryComposition {
  const ownership = searchWorkerOwnership(kernelPool);
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the native Search node');
  const cleanupSearch = createOpenSearch(url);
  const prefix = `discovery-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  // Allocate the transport lazily; service() remains synchronous like createSearchService.
  let proxy: Awaited<ReturnType<typeof searchProxy>> | undefined;
  let transport: Promise<OpenSearch> | undefined;
  const connect = () =>
    (transport ??= searchProxy(url).then((value) => {
      proxy = value;
      return createOpenSearch(value.url);
    }));
  const search: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      return (await connect()).request<T>(...args);
    },
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      return (await connect()).bulk<T>(...args);
    },
    async bulkRaw<T>(...args: Parameters<NonNullable<OpenSearch['bulkRaw']>>) {
      return (await connect()).bulkRaw!<T>(...args);
    },
  };
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  let instrumentedWorker: ReturnType<typeof createOutcomeWorker> | undefined;
  let env: Record<string, string | undefined> | undefined;
  let config: Parameters<typeof createKernel>[0] | undefined;
  let publicFilters: DefaultPublicFilterRuntime | undefined;
  let preparationClient: Promise<WorkClient> | undefined;
  let databaseUrl: string | undefined;
  let started = false;
  let workerTail = Promise.resolve();
  let request: Request | undefined;
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let sealed = false;
  let frozenInstant: number | undefined;
  let clockPending = Promise.resolve();
  let clockFailure: unknown;
  let clockUpdates = 0;
  const operations = new Set<Promise<unknown>>();
  function track<T>(pending: Promise<T>): Promise<T> {
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  }
  function operation<T>(run: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(new Error('Released discovery runtime is closed'));
    if (!started) return Promise.reject(new Error('Released discovery runtime has not started'));
    // Admit worker controls in invocation order, including synchronous fixture clock transitions.
    try {
      return track(run());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function native() {
    if (!publicFilters) throw new Error('Released discovery runtime has not received installed Kernel Access');
    return publicFilters;
  }
  function workerOperation<T>(run: () => Promise<T>): Promise<T> {
    const pending = workerTail.then(run);
    workerTail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  function workerRequest<T>(method: string, params?: unknown): Promise<T> {
    if (instrumentedWorker) return instrumentedWorker.request<T>(method, params);
    if (worker) return worker.rpc.request<T>(method, params);
    return Promise.reject(new Error('Released discovery worker has not started'));
  }
  async function retain(job: ReleasedNativeRepairJob, options?: Readonly<{ expiresAt: number }>): Promise<string> {
    if (!config || !databaseUrl) throw new Error('Released discovery preparation has not started');
    preparationClient ??= createWorkClient(databaseUrl, config.pool);
    const client = await preparationClient;
    const now = Date.now();
    const expiresAt = options === undefined ? now + 24 * 60 * 60 * 1000 : options.expiresAt;
    if (options !== undefined) {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1000)
        throw new RangeError('Preparation expiresAt must be a safe future instant within 24 hours');
    }
    return createPublicPreparationStore(config.pool, client, prefix).retain(
      { kind: 'repair', key: JSON.stringify(job), job },
      expiresAt,
    );
  }
  const control: ReleasedDiscoveryRuntime = {
    indexPrefix: prefix,
    workerKind: ownership.kind,
    bindRequest: (...args) => operation(() => native().bindRequest(...args)),
    resumeRequest: (...args) => operation(() => native().resumeRequest(...args)),
    repair: (...args) => operation(() => native().repair(...args)),
    preparePublication: (...args) => operation(() => native().preparePublication(...args)),
    barrier(boundary) {
      if (sealed || !started || !proxy) throw new Error('Released discovery transport is not running');
      return proxy.barrier(boundary);
    },
    freshness: () =>
      operation(async () => {
        if (!config || !publicFilters) throw new SearchUnavailableError('Released discovery owner is unavailable');
        const { active } = await subjectGenerations(search, prefix);
        if (active === null) throw new SearchUnavailableError('Released discovery current generation is unavailable');
        return readFreshness(config.pool, subjectConsumer(prefix, active));
      }),
    preparePublic: (job, options) => operation(() => retain(job, options)),
    readPreparation: (id) =>
      operation(async () => {
        const result = await config!.pool.query<PreparationRecord>(
          `SELECT id, revision::text, locator, expires_at::text FROM search.public_preparation
         WHERE partition_no = 0 AND prefix = $1 AND id = $2`,
          [prefix, id],
        );
        return result.rows[0] ?? null;
      }),
    workerStats: () => operation(() => workerOperation(() => workerRequest<WorkerStats>('stats'))),
    async crash() {
      ownership.requireOwnedChild();
      return operation(() => workerOperation(() => worker!.crash()));
    },
    async restart() {
      ownership.requireOwnedChild();
      const initialInstant = frozenInstant;
      return operation(() =>
        workerOperation(async () => {
          if (!worker?.exited) throw new Error('Restart requires confirmed actual worker exit');
          // Reuse the original environment, database, prefix and durable preparations verbatim.
          worker = startOutcomeWorkerProcess(
            env!,
            initialInstant === undefined ? {} : { frozenInstant: initialInstant },
          );
          return worker.ready;
        }),
      );
    },
    indexing: (state) =>
      operation(() =>
        workerOperation(async () => {
          await workerRequest('indexing', { state });
        }),
      ),
    converge: (subjects) =>
      operation(async () => {
        for (const subject of subjects) {
          const read = await request!(`/v1/subjects/${subject.id}`);
          if (read.status !== 200) throw new Error(`Read convergence witness: ${JSON.stringify(read.body)}`);
          const label = (read.body.subject as { labels: Record<string, string> }).labels.en;
          if (!label) throw new Error(`Convergence witness ${subject.id} has no English label`);
          const deadline = Date.now() + 15_000;
          let last: unknown;
          for (;;) {
            const result = await request!('/v1/subjects:search', { text: JSON.stringify(label), limit: 100 });
            last = result;
            if (result.status === 200) {
              const subjects = result.body.subjects as { id: string }[];
              if (subjects.some(({ id }) => id === subject.id)) break;
            } else if (
              result.status !== 503 ||
              !['index_not_ready', 'semantic_not_ready'].includes(String(result.body.code))
            ) {
              throw new Error(`Search convergence failed: ${JSON.stringify(result.body)}`);
            }
            if (Date.now() >= deadline)
              throw new Error(`Search did not converge for ${subject.id}: ${JSON.stringify(last)}`);
            await Bun.sleep(25);
          }
        }
      }),
    rebuild: () =>
      operation(() =>
        workerOperation(() => workerRequest<Awaited<ReturnType<ReleasedDiscoveryRuntime['rebuild']>>>('rebuild')),
      ),
  };
  return {
    control,
    onClockChange(instant: Date): void {
      if (sealed) throw new Error('Released discovery runtime is closed');
      if (clockFailure !== undefined) throw clockFailure;
      if (!(instant instanceof Date)) throw new Error('Fixture clock transition requires a Date');
      const value = outcomeClockInstant(instant.getTime());
      if (frozenInstant !== undefined && value < frozenInstant) throw new Error('Fixture clock cannot move backwards');
      if (clockUpdates >= 64) throw new Error('Too many pending fixture clock transitions');
      frozenInstant = value; // Store only the scalar, never the caller's mutable Date.
      if (!starting) return; // Lazy construction: init will acknowledge the latest pre-start instant.
      clockUpdates += 1;
      clockPending = track(
        workerOperation(async () => {
          await starting;
          if (clockFailure !== undefined) throw clockFailure;
          // Instrumentation already owns the original shared closure; never replace it with a replica.
          if (worker) await worker.setClock(value);
          else if (!instrumentedWorker) throw new Error('Released discovery worker has not started');
        })
          .catch((error: unknown) => {
            clockFailure ??= error;
            throw error;
          })
          .finally(() => {
            clockUpdates -= 1;
          }),
      );
    },
    flushClock(): Promise<void> {
      if (sealed) return Promise.reject(new Error('Released discovery runtime is closed'));
      if (clockFailure !== undefined) return Promise.reject(clockFailure);
      if (frozenInstant === undefined) return Promise.resolve();
      if (!starting) return Promise.reject(new Error('Released discovery worker has not started'));
      // Join the lifecycle queue too: an earlier restart must acknowledge init before this flush completes.
      const pending = clockPending;
      return track(
        workerOperation(async () => {
          await starting;
          await pending;
          if (sealed) throw new Error('Released discovery runtime is closed');
          if (clockFailure !== undefined) throw clockFailure;
          worker?.assertClockCustody();
        }),
      );
    },
    onAccessReady(access: Access): void {
      if (sealed || !config || publicFilters) throw new Error('Released discovery Access composition is not available');
      composeSearchSemanticSource();
      publicFilters = createDefaultPublicFilterRuntime({
        pool: config.pool,
        routeKey: config.routeKey,
        access,
        search,
        prefix,
        clock: config.clock ?? systemClock,
      });
    },
    service(installed: Parameters<typeof createKernel>[0]) {
      if (sealed || config) throw new Error('Released discovery service composition already attempted or closed');
      config = installed;
      if (!config.tokens) throw new Error('Shared fixture must supply its actual session keys');
      const { source, ratings } = createRatedSubjectSource(config.pool, config.routeKey);
      return createSearchService({
        pool: config.pool,
        client: search,
        prefix,
        source,
        ratings,
        cursors: config.tokens,
        clock: config.clock ?? systemClock,
        publicFilters: native,
        async preparePublic(job) {
          await retain(job);
        },
      });
    },
    start(runtime: SemanticOutcomeDriver['fixtures']['runtime'], send: Request): Promise<void> {
      if (sealed || starting)
        return Promise.reject(new Error('Released discovery runtime start already attempted or closed'));
      const initialInstant = frozenInstant;
      return (starting = workerOperation(async () => {
        request = send;
        databaseUrl = runtime.databaseUrl;
        await connect();
        env = workerTestEnv({
          DATABASE_URL: runtime.databaseUrl,
          KERNEL_ROUTE_KEY: runtime.routeKey,
          KERNEL_SESSION_KEYS: runtime.sessionKeys,
          AUTH_ISSUER: runtime.authIssuer,
          AUTH_AUDIENCE: runtime.authAudience,
          AUTH_JWKS_URL: runtime.authJwksUrl,
          OPENSEARCH_URL: proxy!.url,
          KERNEL_SEARCH_PREFIX: prefix,
        });
        if (kernelPool) {
          instrumentedWorker = createOutcomeWorker({ kernelPool, clock: config?.clock ?? systemClock });
          await instrumentedWorker.request<WorkerStats>('init', { env });
        } else {
          worker = startOutcomeWorkerProcess(env, initialInstant === undefined ? {} : { frozenInstant: initialInstant });
          await worker.ready;
        }
        started = true;
      }));
    },
    close(): Promise<void> {
      sealed = true;
      return (closing ??= (async () => {
        proxy?.releaseBarriers();
        await starting?.catch(() => {});
        proxy?.releaseBarriers();
        await Promise.allSettled([...operations]);
        const errors: unknown[] = [];
        const attempt = async (run: () => Promise<unknown>) => {
          try {
            await run();
          } catch (error) {
            errors.push(error);
          }
        };
        await attempt(() => clockPending);
        await attempt(async () => worker?.close());
        await attempt(async () => instrumentedWorker?.close());
        // A failed drain must never permit deleting the running worker's index.
        if (worker && !worker.exited)
          throw new AggregateError(errors, 'Released discovery worker exit was not confirmed');
        await attempt(async () => publicFilters?.close());
        await attempt(async () => (await preparationClient)?.close());
        // Runtime/IPC/transport handles are drained before any native state is removed.
        await attempt(async () => {
          await transport?.catch(() => {});
          await proxy?.close();
        });
        if (errors.length) throw new AggregateError(errors, 'Released discovery runtime drain failed');
        // An unstarted composition never acquired an engine handle or created native state.
        if (!transport && !starting) return;
        await attempt(async () => {
          const { generations } = await subjectGenerations(cleanupSearch, prefix);
          for (const generation of generations)
            await attempt(() => cleanupSearch.request('DELETE', `/${subjectIndexName(prefix, generation)}`));
        });
        for (const template of [SEARCH_TEMPLATE, HIT_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
          await attempt(async () => {
            try {
              await cleanupSearch.request('DELETE', `/_scripts/${prefix}${template}`);
            } catch (error) {
              if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
            }
          });
        if (errors.length) throw new AggregateError(errors, 'Released discovery native Search cleanup failed');
      })());
    },
  };
}
