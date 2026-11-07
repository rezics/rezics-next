import type { Pool } from 'pg';
import type { WorkClient } from '../work/client.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { SubjectSourceKeyTraversal as SubjectSourceKeyPages } from '../semantic/subject-source-key-pages.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';
import type { GenerationPublicationJob } from './generation-publication.ts';
import type { DefaultPublicFilterRuntime } from './public-runtime.ts';
import type { OpenSearch } from './opensearch.ts';
import { SearchUnavailableError } from './opensearch.ts';
import {
  createSubjectIndex,
  markSubjectCalendarReady,
  readSubjectCalendarMappingFormat,
  subjectIndexName,
  subjectGenerations,
} from './indices.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';
import {
  createPublicPreparationStore,
  type PopulationFrontier,
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
  let paused = false;
  let stopped = false;
  const running = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    running.add(promise);
    void promise.finally(() => running.delete(promise)).catch(() => {});
    return promise;
  };
  async function enqueueRepair(job: PublicFilterConsumerJob): Promise<void> {
    // No reservation/output/grant is created here: this is the producer's already-admitted job locator.
    await store.retain({ kind: 'repair', key: JSON.stringify(job), job }, Date.now() + 24 * 60 * 60 * 1000);
  }
  async function population(
    record: PreparationRecord,
    state: PopulationFrontier,
    context: PublicFilterConsumerContext,
  ) {
    const index = subjectIndexName(options.prefix, state.generation);
    const calendarFormat = await readSubjectCalendarMappingFormat(options.search, options.prefix, state.generation);
    const release = await activeRelease(options.pool);
    if (!release || release.digest !== state.meaning || (await indexUuid(options.search, index)) !== state.uuid)
      return store.advance(record, state, 5000);
    // Resume the original native job directly. Re-registering from today's Source definition
    // can replace its consumer and strand a retained fence or ambiguous alias intent.
    if (state.publication === null) {
      // prepare commits before this scheduler saves its locator. Recover that original
      // job too when interruption falls between those two durable writes.
      const existing = (
        await options.pool.query<{ job: string }>(
          `SELECT job FROM search.generation_publication
         WHERE partition_no=0 AND physical_target=$1 AND native_incarnation=$2 AND consumer->>'meaningDigest'=$3
         ORDER BY (fence IS NOT NULL) DESC,activated_at,job LIMIT 1`,
          [index, state.uuid, state.meaning],
        )
      ).rows[0];
      if (existing) return store.advance(record, { ...state, publication: existing.job, phase: 'native' });
      const prepared = await options.runtime.preparePublication(state.generation, context);
      if (prepared.status !== 'preparing') return store.advance(record, state, 1000);
      return store.advance(record, { ...state, publication: prepared.job.job, phase: 'native' });
    }
    const retained = await options.pool.query<{ consumer: GenerationPublicationJob['consumer'] }>(
      `SELECT consumer FROM search.generation_publication
       WHERE partition_no=0 AND job=$1 AND physical_target=$2`,
      [state.publication, index],
    );
    const job: GenerationPublicationJob = { job: state.publication, consumer: retained.rows[0]!.consumer };
    // Publication already enumerates complete native key pages, repairs through the ordinary
    // writer and reconciles engine extras. The retired fixed-cut scan was a second population
    // frontier whose Source adapter is unavailable; it must not gate this existing lifecycle.
    if (state.phase !== 'activate') {
      const reconciliation = await options.runtime.publication.step(job, context);
      return store.advance(
        record,
        { ...state, phase: reconciliation.status === 'reconciled' ? 'activate' : 'native' },
        reconciliation.status === 'progress' || reconciliation.status === 'reconciled' ? 0 : 1000,
      );
    }
    if (calendarFormat === 1) await markSubjectCalendarReady(options.search, options.prefix, state.generation);
    const activated = await options.runtime.publication.activate(job, context);
    if (activated.status === 'activated') return store.advance(record, null);
    return store.advance(record, activated.status === 'preparing' ? { ...state, phase: 'native' } : state, 1000);
  }

  return {
    enqueueRepair,
    /** The actual ordinary writer checks the native publication gate inside its enrollment transaction. */
    writer(_generation: number): import('./indexer.ts').SubjectApplyGuard {
      return async (_partition, _envelopes, apply) => apply();
    },
    initialize(generation: number, signal?: AbortSignal): Promise<string> {
      return track(async () => {
        const ensureLive = () => {
          if (stopped || signal?.aborted)
            throw new SearchUnavailableError('Public preparation initialization was cancelled');
        };
        ensureLive();
        const current = await activeRelease(options.pool);
        ensureLive();
        if (!current) throw new SearchUnavailableError('Public preparation release is unavailable');
        const state = await subjectGenerations(options.search, options.prefix, undefined, signal);
        ensureLive();
        if (!state.generations.includes(generation)) {
          if (state.generations.length >= 3) throw new SearchUnavailableError('Public generation limit reached');
          await createSubjectIndex(options.search, options.prefix, generation, 1, signal);
          ensureLive();
        }
        const uuid = await indexUuid(options.search, subjectIndexName(options.prefix, generation), signal);
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
        );
      });
    },
    run(id: string, revision: string): Promise<void> {
      return track(async () => {
        if (paused || stopped) return;
        const context = { deadline: Date.now() + 30_000 };
        const record = await store.claim(id, revision, context.deadline);
        if (!record) return;
        if (Number(record.expires_at) <= Date.now()) return store.advance(record, null);
        if (record.locator.kind === 'population') return population(record, record.locator, context);
        const outcome = await options.runtime.repair(record.locator.job, context);
        // 'settled' releases scheduling only. It never activates a generation or certifies output.
        await store.advance(
          record,
          outcome.status === 'settled' ? null : record.locator,
          outcome.status === 'progress' ? 0 : 1000,
        );
      });
    },
    discover() {
      return paused || stopped ? Promise.resolve() : track(() => store.due());
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
