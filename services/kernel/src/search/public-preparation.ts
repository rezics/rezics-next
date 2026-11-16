import type { Pool } from 'pg';
import { withBoundedReadConnection } from '../database/pool.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import type { WorkClient } from '../work/client.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { SubjectSourceKeyTraversal as SubjectSourceKeyPages } from '../semantic/subject-source-key-pages.ts';
import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerJob,
  PublicFilterConsumerUnavailable,
} from './public-filter-consumer-contract.ts';
import type { GenerationPublicationJob } from './generation-publication.ts';
import type { DefaultPublicFilterRuntime } from './public-runtime.ts';
import type { OpenSearch } from './opensearch.ts';
import { SearchUnavailableError } from './opensearch.ts';
import {
  createSubjectIndex,
  markSubjectCalendarReady,
  subjectIndexName,
  subjectGenerations,
} from './indices.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';
import {
  createPublicPreparationStore,
  PUBLIC_PREPARATION_BUDGET_MS,
  type PopulationFrontier,
  type PreparationLocator,
  type PreparationRecord,
} from './public-preparation-store.ts';

export type PublicPreparation = ReturnType<typeof createPublicPreparation>;
export type PublicPreparationOptions = {
  pool: Pool;
  work: WorkClient;
  search: OpenSearch;
  prefix: string;
  source: SubjectSource & SubjectSourceKeyPages;
  listing: SubjectListingSource;
  runtime: DefaultPublicFilterRuntime;
};

// Bound how many independently metered native publication turns can share one
// maintenance delivery and its original deadline.
const publicationTurnsPerDelivery = 4;

const databaseLifetimeOptions = {
  deadlineError: () => new SearchUnavailableError('Public preparation database deadline expired'),
  isUncertainSettledQueryError: () => true,
};

/** Resolve actual physical identity before each admitted write. The name alone conveys no readiness. */
async function indexUuid(search: OpenSearch, index: string, signal?: AbortSignal): Promise<string> {
  const { status, body } = await search.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
    'GET',
    `/${index}/_settings`,
    undefined,
    signal ? { signal } : undefined,
  );
  const uuid = body[index]?.settings?.index?.uuid;
  if (status !== 200 || Object.keys(body).length !== 1 || typeof uuid !== 'string' || !uuid)
    throw new SearchUnavailableError('Public preparation physical identity is unavailable');
  return uuid;
}

/** Operational continuation only. Source/consumer producers own membership, repair and native publication evidence. */
export function createPublicPreparation(options: PublicPreparationOptions) {
  const store = createPublicPreparationStore(options.pool, options.work, options.prefix);
  const readRelease = (deadline: number) =>
    withBoundedReadConnection(options.pool, deadline, (client) => activeRelease(client), databaseLifetimeOptions);
  const searchWithin = (deadline: number): OpenSearch => ({
    ...options.search,
    async request<T = unknown>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body, requestOptions] = args;
      const remaining = deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0)
        throw new SearchUnavailableError('Public preparation search deadline expired');
      const controller = new AbortController();
      const abort = () => controller.abort(requestOptions?.signal?.reason);
      if (requestOptions?.signal?.aborted) abort();
      else requestOptions?.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new SearchUnavailableError('Public preparation search deadline expired')),
        Math.ceil(remaining),
      );
      try {
        return await options.search.request<T>(method, path, body, { ...requestOptions, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        requestOptions?.signal?.removeEventListener('abort', abort);
      }
    },
  });
  let paused = false;
  let stopped = false;
  const running = new Set<Promise<unknown>>();
  type PublicationPhase = 'prepare' | 'step' | 'activate';
  const unavailable = new Map<PublicationPhase, string>();
  const failures = new Map<PreparationLocator['kind'], string>();
  const reportFailure = (kind: PreparationLocator['kind'], error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const state = `${name}:${message}`;
    if (failures.get(kind) === state) return;
    failures.set(kind, state);
    console.warn(JSON.stringify({ event: 'search.public_preparation.failed', prefix: options.prefix, kind, name, message }));
  };
  const reportUnavailable = (phase: PublicationPhase, generation: number, result: PublicFilterConsumerUnavailable) => {
    const state = `${generation}:${result.reason}`;
    if (unavailable.get(phase) === state) return;
    unavailable.set(phase, state);
    console.warn(
      JSON.stringify({
        event: 'search.public_preparation.unavailable',
        prefix: options.prefix,
        generation,
        phase,
        reason: result.reason,
      }),
    );
  };
  const track = <T>(deadline: number, operation: () => Promise<T>): Promise<T> => {
    const promise = withRequestDeadline(deadline, operation);
    running.add(promise);
    void promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  };
  async function enqueueRepair(job: PublicFilterConsumerJob, deadline = deadlineFor(30_000)): Promise<void> {
    // No reservation/output/grant is created here: this is the producer's already-admitted job locator.
    await store.retain({ kind: 'repair', key: JSON.stringify(job), job }, Date.now() + 24 * 60 * 60 * 1000, deadline);
  }
  async function population(
    record: PreparationRecord,
    state: PopulationFrontier,
    context: PublicFilterConsumerContext,
    mayContinue: boolean,
  ): Promise<string | undefined> {
    const advance = async (locator: PreparationLocator | null, delayMs = 0, ready = false) => {
      const continueInline = mayContinue && ready;
      const revision = await store.advance(record, locator, delayMs, context.deadline, continueInline);
      return continueInline ? (revision ?? undefined) : undefined;
    };
    const search = searchWithin(context.deadline);
    const index = subjectIndexName(options.prefix, state.generation);
    if ((await indexUuid(search, index)) !== state.uuid) return advance(state, 5000);
    // Resume the original native job directly. Re-registering from today's Source definition
    // can replace its consumer and strand a retained fence or ambiguous alias intent.
    if (state.publication === null) {
      // prepare commits before this scheduler saves its locator. Recover that original
      // job too when interruption falls between those two durable writes.
      const existing = (
        await withBoundedReadConnection(
          options.pool,
          context.deadline,
          (client) =>
            client.query<{ job: string }>(
              `SELECT job FROM search.generation_publication
         WHERE partition_no=0 AND physical_target=$1 AND native_incarnation=$2 AND consumer->>'meaningDigest'=$3
         ORDER BY (fence IS NOT NULL) DESC,activated_at,job LIMIT 1`,
              [index, state.uuid, state.meaning],
            ),
          databaseLifetimeOptions,
        )
      ).rows[0];
      if (existing) return advance({ ...state, publication: existing.job, phase: 'native' });
      const release = await readRelease(context.deadline);
      if (!release) return advance(state, 5000);
      if (release.digest !== state.meaning) {
        // No native publication has been admitted for this frontier. Move its
        // typed locator to the active release; advance fences any older delivery.
        return advance({
          ...state,
          meaning: release.digest,
          publication: null,
          partition: 0,
          epoch: null,
          through: null,
          after: null,
          phase: 'native',
          pending: null,
        });
      }
      const prepared = await options.runtime.preparePublication(state.generation, context);
      if (prepared.status !== 'preparing') {
        reportUnavailable('prepare', state.generation, prepared);
        return advance(state, 1000);
      }
      unavailable.delete('prepare');
      return advance({ ...state, publication: prepared.job.job, phase: 'native' });
    }
    const retained = await withBoundedReadConnection(
      options.pool,
      context.deadline,
      (client) =>
        client.query<{ consumer: GenerationPublicationJob['consumer'] }>(
          `SELECT consumer FROM search.generation_publication
       WHERE partition_no=0 AND job=$1 AND physical_target=$2`,
          [state.publication, index],
        ),
      databaseLifetimeOptions,
    );
    const job: GenerationPublicationJob = { job: state.publication, consumer: retained.rows[0]!.consumer };
    // Publication already enumerates complete native key pages, repairs through the ordinary
    // writer and reconciles engine extras. The retired fixed-cut scan was a second population
    // frontier whose Source adapter is unavailable; it must not gate this existing lifecycle.
    if (state.phase !== 'activate') {
      const reconciliation = await options.runtime.publication.step(job, context, { enrollSource: true });
      if (reconciliation.status === 'unavailable') reportUnavailable('step', state.generation, reconciliation);
      else unavailable.delete('step');
      const ready = reconciliation.status === 'progress' || reconciliation.status === 'reconciled';
      return advance(
        { ...state, phase: reconciliation.status === 'reconciled' ? 'activate' : 'native' },
        ready ? 0 : 1000,
        ready,
      );
    }
    await markSubjectCalendarReady(search, options.prefix, state.generation);
    const activated = await options.runtime.publication.activate(job, context);
    if (activated.status === 'unavailable') reportUnavailable('activate', state.generation, activated);
    else unavailable.delete('activate');
    if (activated.status === 'activated') return advance(null);
    if (activated.status === 'preparing') {
      const next = { ...state, phase: activated.next === 'activate' ? ('activate' as const) : ('native' as const) };
      return advance(
        next,
        activated.advanced ? 0 : 1000,
        activated.advanced === true,
      );
    }
    // An unready activation can have durably restarted reconciliation. The subsequent step
    // will resolve its native phase, including a retained fence or ambiguous alias intent.
    return advance({ ...state, phase: 'native' }, 1000);
  }

  return {
    enqueueRepair,
    /** The actual ordinary writer checks the native publication gate inside its enrollment transaction. */
    writer(_generation: number): import('./indexer.ts').SubjectApplyGuard {
      return async (_partition, _envelopes, apply) => apply();
    },
    initialize(generation: number, signal?: AbortSignal, deadline = deadlineFor(30_000)): Promise<string> {
      return track(deadline, async () => {
        const ensureLive = () => {
          if (stopped || signal?.aborted || Date.now() >= deadline)
            throw new SearchUnavailableError('Public preparation initialization was cancelled');
        };
        ensureLive();
        const current = await readRelease(deadline);
        ensureLive();
        if (!current) throw new SearchUnavailableError('Public preparation release is unavailable');
        const search = searchWithin(deadline);
        const state = await subjectGenerations(search, options.prefix, undefined, signal);
        ensureLive();
        if (!state.generations.includes(generation)) {
          if (state.generations.length >= 3) throw new SearchUnavailableError('Public generation limit reached');
          await createSubjectIndex(search, options.prefix, generation, signal);
          ensureLive();
        }
        const uuid = await indexUuid(search, subjectIndexName(options.prefix, generation), signal);
        ensureLive();
        return store.retain(
          {
            kind: 'population',
            key: String(generation),
            generation,
            uuid,
            meaning: current.digest,
            publication: null,
            partition: 0,
            epoch: null,
            through: null,
            after: null,
            phase: 'native',
            pending: null,
          },
          Date.now() + 24 * 60 * 60 * 1000,
          deadline,
        );
      });
    },
    run(id: string, revision: string, deadline = deadlineFor(PUBLIC_PREPARATION_BUDGET_MS)): Promise<void> {
      const context = {
        deadline: Math.min(deadline, deadlineFor(PUBLIC_PREPARATION_BUDGET_MS), Date.now() + PUBLIC_PREPARATION_BUDGET_MS),
      };
      return track(context.deadline, async () => {
        for (let turn = 1; turn <= publicationTurnsPerDelivery && !paused && !stopped; turn++) {
          const record = await store.claim(id, revision, context.deadline);
          if (!record) return;
          if (Number(record.expires_at) <= Date.now()) {
            await store.advance(record, null, 0, context.deadline);
            return;
          }
          try {
            if (record.locator.kind === 'population') {
              const next = await population(record, record.locator, context, turn < publicationTurnsPerDelivery);
              failures.delete(record.locator.kind);
              if (next === undefined) return;
              revision = next;
            } else {
              const outcome = await options.runtime.repair(record.locator.job, context);
              // 'settled' releases scheduling only. It never activates a generation or certifies output.
              await store.advance(
                record,
                outcome.status === 'settled' ? null : record.locator,
                outcome.status === 'progress' ? 0 : 1000,
                context.deadline,
              );
              failures.delete(record.locator.kind);
              return;
            }
          } catch (error) {
            reportFailure(record.locator.kind, error);
            throw error;
          }
        }
      });
    },
    discover(deadline = deadlineFor(30_000)) {
      return paused || stopped ? Promise.resolve() : track(deadline, () => store.due(deadline));
    },
    async pause() {
      paused = true;
      await Promise.allSettled([...running]);
    },
    resume() {
      if (!stopped) paused = false;
    },
    async stop() {
      stopped = true;
      paused = true;
      await Promise.allSettled([...running]);
    },
  };
}
