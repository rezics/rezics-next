import type { Pool } from 'pg';
import type { WorkClient } from '../work/client.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readPartition } from '../partition/partition.ts';
import type { SubjectSourceKeyTraversal as SubjectSourceKeyPages } from '../semantic/subject-source-key-pages.ts';
import type { PublicFilterConsumerContext, PublicFilterConsumerJob } from './public-filter-consumer-contract.ts';
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
import { applySubjectKeys, createSubjectIndexer } from './indexer.ts';
import type { SubjectListingSource, SubjectSource } from './source.ts';
import { subjectPartition } from './source.ts';
import { routeOf } from '../route/route.ts';
import { subjectConsumer } from './runner.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
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
async function indexUuid(search: OpenSearch, index: string): Promise<string> {
  const { status, body } = await search.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
    'GET',
    `/${index}/_settings`,
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
    const publication = await options.runtime.preparePublication(state.generation, context);
    if (publication.status !== 'preparing') return store.advance(record, state, 1000);
    if (state.publication !== null && state.publication !== publication.job.job)
      throw new SearchUnavailableError('Public publication identity changed during population');
    if (state.publication === null) return store.advance(record, { ...state, publication: publication.job.job });
    const writer = createSearchWriterGuard({
      pool: options.pool,
      search: options.search,
      source: options.source,
      listing: options.listing,
      index,
      consumer: subjectConsumer(options.prefix, state.generation),
      ...(calendarFormat === null ? {} : { calendarFormat }),
    });
    if (state.partition === 4096) {
      if (state.phase !== 'activate') {
        const reconciliation = await options.runtime.publication.step(publication.job, context);
        return store.advance(
          record,
          {
            ...state,
            phase: reconciliation.status === 'reconciled' ? 'activate' : 'native',
          },
          reconciliation.status === 'progress' || reconciliation.status === 'reconciled' ? 0 : 1000,
        );
      }
      if (calendarFormat === 1)
        await markSubjectCalendarReady(options.search, options.prefix, state.generation);
      const activated = await options.runtime.publication.activate(publication.job, context);
      if (activated.status === 'activated') {
        if (activated.consumer.physicalTarget !== index)
          throw new SearchUnavailableError('Public publication activated the wrong generation');
        return store.advance(record, null);
      }
      return store.advance(record, activated.status === 'preparing' ? { ...state, phase: 'native' } : state, 1000);
    }
    const home = await readPartition(options.pool, state.partition);
    if (!home || home.writeState !== 'active') return store.advance(record, state, 1000);
    if (state.epoch !== null && state.epoch !== home.epoch) return store.advance(record, state, 1000); // Retain the unresolved bridge; do not restart settled homes.
    if (state.through === null) {
      // Arm ordinary log retention before any key traversal. Epoch/head are native, never a public cut.
      await options.pool.query(
        `INSERT INTO core.consumer_checkpoint(partition_no, consumer)
        VALUES ($1, $2) ON CONFLICT (partition_no, consumer) DO NOTHING`,
        [state.partition, subjectConsumer(options.prefix, state.generation)],
      );
      return store.advance(record, { ...state, epoch: home.epoch, through: String(home.position) });
    }
    if (state.phase === 'replay') {
      const relay = createSubjectIndexer({
        ...options,
        index,
        consumer: subjectConsumer(options.prefix, state.generation),
        envelopes: 1,
        writer,
        ...(calendarFormat === null ? {} : { calendarFormat }),
      });
      const replay = await relay.run(state.partition);
      if (replay.status !== 'read') return store.advance(record, state, 1000);
      if (replay.position < home.position) return store.advance(record, state);
      return store.advance(record, {
        ...state,
        partition: state.partition + 1,
        phase: 'scan',
        epoch: null,
        through: null,
        after: null,
        pending: null,
      });
    }
    if (state.pending) {
      // A crash can replay only this retained step, through the same ordinary serializer/version writer.
      await applySubjectKeys(
        { ...options, index, writer, ...(calendarFormat === null ? {} : { calendarFormat }) },
        state.partition,
        state.pending.keys,
        BigInt(state.pending.position),
      );
      return store.advance(record, {
        ...state,
        after: state.pending.after,
        pending: null,
        phase: state.pending.complete ? 'replay' : 'scan',
      });
    }
    // A small real owner batch leaves room for its complete dependency/Source-read budgets.
    const page = await options.source.readSubjectKeyPage(
      {
        partition: state.partition,
        epoch: state.epoch!,
        after: state.after,
        through: BigInt(state.through),
        inputLimit: 64,
      },
      context,
    );
    if (page.status !== 'progress' && page.status !== 'complete') return store.advance(record, state, 1000);
    if (
      page.partition !== state.partition ||
      page.epoch !== state.epoch ||
      page.through !== BigInt(state.through) ||
      page.keys.length > 64 ||
      new Set(page.keys).size !== page.keys.length ||
      page.cost.inputKeys > 64 ||
      page.keys.some((key) => subjectPartition(key) !== state.partition) ||
      (page.status === 'progress' && JSON.stringify(page.after) === JSON.stringify(state.after))
    )
      throw new TypeError('Invalid native public population key page');
    let previous = state.after;
    for (const key of page.keys) {
      const route = routeOf(key)!;
      if (previous && (route < previous.route || (route === previous.route && key <= previous.id)))
        throw new TypeError('Public population key page did not advance its native route frontier');
      previous = { route, id: key };
    }
    return store.advance(record, {
      ...state,
      pending: {
        keys: [...page.keys],
        after: page.after,
        complete: page.status === 'complete',
        position: String(page.position),
      },
    });
  }
  return {
    enqueueRepair,
    /** The actual ordinary writer checks the native publication gate inside its enrollment transaction. */
    writer(_generation: number): import('./indexer.ts').SubjectApplyGuard {
      return async (_partition, _envelopes, apply) => apply();
    },
    async initialize(generation: number): Promise<string> {
      const current = await activeRelease(options.pool);
      if (!current) throw new SearchUnavailableError('Public preparation release is unavailable');
      const state = await subjectGenerations(options.search, options.prefix);
      if (!state.generations.includes(generation)) {
        if (state.generations.length >= 3) throw new SearchUnavailableError('Public generation limit reached');
        await createSubjectIndex(options.search, options.prefix, generation, 1);
      }
      return store.retain(
        {
          kind: 'population',
          key: String(generation),
          generation,
          uuid: await indexUuid(options.search, subjectIndexName(options.prefix, generation)),
          meaning: current.digest,
          publication: null,
          partition: 0,
          epoch: null,
          through: null,
          after: null,
          phase: 'scan',
          pending: null,
        },
        Date.now() + 24 * 60 * 60 * 1000,
      );
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
