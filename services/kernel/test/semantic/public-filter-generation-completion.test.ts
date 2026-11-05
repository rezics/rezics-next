import { expect, test } from 'bun:test';
import { fixture, nativeProducer, readContext } from './support/public-filter-source.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import {
  createPublicFilterCustody,
  decodePublicFilterNativeState,
} from '../../src/search/public-filter-custody.ts';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectConsumer } from '../../src/search/runner.ts';

// Actual generation, original Source, ordinary writer and engine: no home/ACK/phase setters.
test('generation restart keeps the original Source proof through lost observation, dispatch and drained replies', async () => {
  const f = await fixture();
  const { publicFilterSource } = await nativeProducer();
  const source = publicFilterSource(f.config);
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `source-publish-${crypto.randomUUID().slice(0, 8)}-`;
  const target = subjectIndexName(prefix, 2);
  const custody = createPublicFilterCustody(f.db.pool);
  let readerBlocked = false;
  let reader: { observation: string; token: string } | undefined;
  let readerPayload: string | null;
  let observationLost = false,
    dispatchLost = false,
    drainLost = false;
  let original:
    | Extract<
        Awaited<ReturnType<typeof readNativePublicFilterPublicationCompletion>>,
        { status: 'pending' | 'complete' }
      >['publication']
    | undefined;
  const bindingPool = new Proxy(f.db.pool, {
    get(pool, key) {
      if (key === 'query')
        return async (sql: string, values?: unknown[]) => {
          const result = await pool.query(sql, values);
          if (!observationLost && sql.includes('SET publication_job=')) {
            observationLost = true;
            throw new Error('Lost generation Source association reply');
          }
          return result;
        };
      const value = Reflect.get(pool, key, pool);
      return typeof value === 'function' ? value.bind(pool) : value;
    },
  });
  const transport: typeof search = {
    request: search.request.bind(search),
    async bulk<T = unknown>(lines: readonly unknown[], options?: Parameters<typeof search.bulk>[1]) {
      const result = await search.bulk<T>(lines, options);
      if (observationLost && !dispatchLost) {
        dispatchLost = true;
        throw new SearchUnavailableError('Lost original native dispatch reply');
      }
      return result;
    },
  };
  const open = () => {
    const writer = createSearchWriterGuard({
      pool: f.db.pool,
      search: transport,
      index: target,
      consumer: subjectConsumer(prefix, 2),
      source: createRatedSubjectSource(f.db.pool, f.config.routeKey).source,
      listing: subjectListingSource(f.db.pool),
    });
    const fence = writer.fencePublication.bind(writer);
    Object.assign(writer, {
      async fencePublication(...args: Parameters<typeof fence>) {
        if (!readerBlocked) {
          const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
          const complete = await readNativePublicFilterPublicationCompletion(
            binding,
            { job: args[0].job },
            readContext(),
          );
          if (complete.status !== 'complete') throw new Error(complete.reason);
          const acquired = await custody.acquire(complete.publication.queried, { deadline: Date.now() + 300000 });
          if (acquired.status !== 'acquired') throw new Error(acquired.reason);
          reader = acquired.use;
          readerPayload = (
            await f.db.pool.query(
              'SELECT prepared_rows FROM search.public_filter_observation WHERE partition_no=0 AND observation=$1',
              [reader.observation],
            )
          ).rows[0].prepared_rows;
        }
        return fence(...args);
      },
    });
    const drain = writer.drainPublication.bind(writer);
    Object.assign(writer, {
      async drainPublication(...args: Parameters<typeof drain>) {
        const result = await drain(...args);
        if (reader) {
          expect(result.status).toBe('draining');
          const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
          const complete = await readNativePublicFilterPublicationCompletion(
            binding,
            { job: args[0].job },
            readContext(),
          );
          if (complete.status !== 'complete') throw new Error(complete.reason);
          expect((await custody.acquire(complete.publication.queried, readContext())).status).not.toBe('acquired');
          expect(
            (
              await f.db.pool.query(
                'SELECT prepared_rows FROM search.public_filter_observation WHERE partition_no=0 AND observation=$1',
                [reader.observation],
              )
            ).rows[0].prepared_rows,
          ).toBe(readerPayload);
          expect((await custody.release(reader, readContext())).status).toBe('released');
          reader = undefined;
          readerBlocked = true;
        }
        if (result.status === 'drained' && !drainLost) {
          drainLost = true;
          throw new SearchUnavailableError('Lost completed native drain reply');
        }
        return result;
      },
    });
    return createSearchGenerationPublication({
      pool: f.db.pool,
      search: transport,
      source,
      sourceKeys: createSubjectSourceKeyPages(f.db.pool, f.config.routeKey, f.config.access),
      binding: createPublicFilterSourceBinding(bindingPool, f.config.routeKey, f.config.access),
      clock: f.config.clock,
      meaning: f.meaning,
      writerGuard: writer,
    });
  };
  try {
    const book = await f.create('schema:Book');
    await createSubjectIndex(search, prefix, 1);
    await createSubjectIndex(search, prefix, 2);
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const resolved = await binding.resolve(
      { source, meaning: f.meaning, capture: { sort: 'id', size: 10, filterDocument: undefined, text: undefined } },
      readContext(),
    );
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: target,
        consumerGeneration: '2',
        projectionGeneration: resolved.definition.readDefinition,
      },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    let publication = open();
    const prepared = await publication.prepare(registered.consumer, readContext());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const job = prepared.job;
    let activated = false;
    for (let step = 0; step < 40000; step++) {
      const progress = await publication.step(job, readContext());
      if (progress.status === 'reconciled') {
        const result = await publication.activate(job, readContext());
        if (result.status === 'activated') {
          activated = true;
          break;
        }
      }
      if (observationLost && !original) {
        const completion = await readNativePublicFilterPublicationCompletion(binding, { job: job.job }, readContext());
        expect('publication' in completion).toBe(true);
        if (!('publication' in completion)) throw new Error(completion.reason);
        original = completion.publication;
        // A current native change is repaired without substituting a new cut or execution.
        await f.propose(book, await f.create());
      }
      // Reopen native factories after every bounded call, including all three lost replies.
      await publication.close();
      publication = open();
      expect((await subjectGenerations(search, prefix)).active).toBe(1);
    }
    await publication.close();
    expect({ activated, observationLost, dispatchLost, drainLost }).toEqual({
      activated: true,
      observationLost: true,
      dispatchLost: true,
      drainLost: true,
    });
    const completed = await readNativePublicFilterPublicationCompletion(binding, { job: job.job }, readContext());
    expect(completed.status).toBe('complete');
    if (completed.status !== 'complete') throw new Error(completed.reason);
    expect(readerBlocked).toBe(true);
    expect(completed.publication).toEqual(original!);
    expect(completed.observation.changed.length).toBeGreaterThan(0);
    const proof = (
      await f.db.pool.query(
        `SELECT o.consumer_work,o.expires_at::text FROM search.public_filter_observation o
         JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
         WHERE r.physical_target=$1`,
        [target],
      )
    ).rows;
    // Temporary materialization has retired; only payload-free original proof custody remains.
    expect(proof).toHaveLength(1);
    expect(decodePublicFilterNativeState(proof[0].consumer_work)).toMatchObject({ prepared: [], preparedRows: [] });
    expect(proof[0].expires_at).toBe(String(Number.MAX_SAFE_INTEGER));
    expect((await subjectGenerations(search, prefix)).active).toBe(2);
    const restarted = open();
    expect((await restarted.activate(job, readContext())).status).toBe('activated');
    await restarted.close();
  } finally {
    await custody.close();
    for (const generation of [1, 2]) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    await f.close();
  }
}, 1200000);
