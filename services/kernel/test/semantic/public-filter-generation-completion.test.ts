import { expect, test } from 'bun:test';
import { fixture, nativeProducer, readContext, statement } from './support/public-filter-source.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { createPublicFilterCustody, decodePublicFilterNativeState } from '../../src/search/public-filter-custody.ts';
import { createOpenSearch, SearchUnavailableError } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createDefaultPublicFilterRuntime } from '../../src/search/public-runtime.ts';
import { PUBLIC_PREPARATION_BUDGET_MS } from '../../src/search/public-preparation-store.ts';
import { PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT } from '../../src/semantic/public-filter-repair-chain.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

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
  let book: string;
  let lateBody: readonly unknown[] | undefined;
  let lateChanged = false;
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
      if (observationLost && !lateBody) {
        const at = lines.findIndex((line) => (line as { index?: { _id: string } }).index?._id === book);
        if (at >= 0) lateBody = structuredClone(lines.slice(at, at + 2));
      }
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
          await f.propose(book, await f.create());
          throw new SearchUnavailableError('Lost completed native drain reply');
        }
        return result;
      },
    });
    const binding = createPublicFilterSourceBinding(bindingPool, f.config.routeKey, f.config.access);
    return createSearchGenerationPublication({
      pool: f.db.pool,
      search: transport,
      source,
      sourceKeys: createSubjectSourceKeyPages(f.db.pool, f.config.routeKey, f.config.access),
      binding,
      readPublicationCompletion: (request, context) =>
        readNativePublicFilterPublicationCompletion(binding, request, context),
      clock: f.config.clock,
      meaning: f.meaning,
      writerGuard: writer,
    });
  };
  try {
    book = await f.create('schema:Book');
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
      if (lateBody && !lateChanged) {
        await f.propose(book, await f.create());
        lateChanged = true;
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
    expect((await custody.acquire(completed.publication.queried, readContext())).status).not.toBe('acquired');
    expect(lateChanged).toBe(true);
    const current = await search.request('GET', `/${target}/_doc/${book}`);
    const late = await search.bulk<{ items: { index: { status: number } }[] }>(lateBody!);
    expect(late.items[0]!.index.status).toBe(409);
    expect((await search.request('GET', `/${target}/_doc/${book}`)).body).toEqual(current.body);
    const restarted = open();
    expect((await restarted.activate(job, readContext())).status).toBe('activated');
    await restarted.close();
  } finally {
    await custody.close();
    for (const generation of [1, 2]) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
    await f.close();
  }
}, 1200000);

test('an unfenced engine page completes after exact inline replay of an advanced Subject home', async () => {
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `source-inline-replay-${crypto.randomUUID().slice(0, 8)}-`;
  const target = subjectIndexName(prefix, 1);
  const runtime = createDefaultPublicFilterRuntime({ ...f.config, search, prefix });
  const writer = createSearchWriterGuard({
    pool: f.db.pool,
    search,
    index: target,
    consumer: subjectConsumer(prefix, 1),
    source: createRatedSubjectSource(f.db.pool, f.config.routeKey).source,
    listing: subjectListingSource(f.db.pool),
  });
  try {
    const book = await f.create('schema:Book');
    const person = await f.create('schema:Person');
    const position = async (id: string) =>
      (
        await f.db.pool.query<{ position: string }>('SELECT position::text FROM core.partition WHERE partition_no=$1', [
          partitionOf(routeOf(id)!),
        ])
      ).rows[0]!.position;
    await createSubjectIndex(search, prefix, 1);
    const admitted = await runtime.preparePublication(1, readContext());
    if (admitted.status !== 'preparing') throw new Error(admitted.reason);
    const { job } = admitted;
    expect(await runtime.publication.step(job, readContext())).toMatchObject({
      status: 'unready',
      reason: 'source_pending',
    });
    const enrollmentStep = await runtime.publication.step(
      job,
      { deadline: Date.now() + PUBLIC_PREPARATION_BUDGET_MS },
      { enrollSource: true },
    );
    expect(enrollmentStep).toMatchObject({ status: 'progress', sourceAdvanced: true });
    const {
      rows: [enrollment],
    } = await f.db.pool.query<{
      state: string;
      coverage_after: number;
      opened_observation: boolean;
    }>(
      `SELECT b.state,b.coverage_after,EXISTS (
         SELECT FROM search.public_filter_observation o
         JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(o.partition_no,o.registration)
         WHERE r.physical_target=j.physical_target
       ) AS opened_observation
       FROM search.generation_publication j
       JOIN semantic.public_filter_bootstrap b
         ON b.partition_no=j.source_home AND b.read_definition::text=j.binding->>'readDefinition'
       WHERE j.partition_no=0 AND j.job=$1`,
      [job.job],
    );
    expect(enrollment).toMatchObject({ state: 'capturing', opened_observation: false });
    expect(enrollment!.coverage_after).toBeGreaterThan(0);
    expect(await subjectGenerations(search, prefix)).toMatchObject({ active: null });
    for (const id of [book, person]) await writer.write(partitionOf(routeOf(id)!), [id], BigInt(await position(id)));
    const publication = async () =>
      (
        await f.db.pool.query<{ phase: string; pit: string | null; has_cursor: boolean }>(
          'SELECT phase,pit,engine_after IS NOT NULL AS has_cursor FROM search.generation_publication WHERE job=$1',
          [job.job],
        )
      ).rows[0]!;
    for (let turn = 0; turn < 24 && !(await publication()).pit; turn++) {
      expect((await runtime.publication.step(job, readContext())).status).toBe('progress');
    }
    const before = await publication();
    expect(before).toMatchObject({ phase: 'engine', has_cursor: false });
    expect(before.pit).toBeTruthy();

    const original = await position(book);
    await f.propose(book, person);
    const advanced = await position(book);
    expect(BigInt(advanced)).toBeGreaterThan(BigInt(original));
    expect((await runtime.publication.step(job, readContext())).status).toBe('progress');
    expect(await publication()).toMatchObject({ phase: 'engine', has_cursor: true });
    const witness = await f.db.pool.query<{ position: string }>(
      'SELECT position::text FROM search.generation_publication_home WHERE (partition_no,job)=($1,$2)',
      [partitionOf(routeOf(book)!), job.job],
    );
    expect(witness.rows).toEqual([{ position: advanced }]);
    expect((await subjectGenerations(search, prefix)).active).toBeNull();
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        await search.request('DELETE', `/${target}`);
      } finally {
        await f.close();
      }
    }
  }
}, 120_000);

test('native publication starts repair from the original adopted Source execution and acknowledges a bounded prefix', async () => {
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `source-repair-start-${crypto.randomUUID().slice(0, 8)}-`;
  const target = subjectIndexName(prefix, 1);
  const runtime = createDefaultPublicFilterRuntime({ ...f.config, search, prefix });
  try {
    const book = await f.create('schema:Book');
    const partition = partitionOf(routeOf(book)!);
    await createSubjectIndex(search, prefix, 1);
    const writer = createSearchWriterGuard({
      pool: f.db.pool,
      search,
      index: target,
      consumer: subjectConsumer(prefix, 1),
      source: createRatedSubjectSource(f.db.pool, f.config.routeKey).source,
      listing: subjectListingSource(f.db.pool),
    });
    const position = await f.db.pool.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no=$1',
      [partition],
    );
    await writer.write(partition, [book], BigInt(position.rows[0]!.position));
    const deadline = Date.now() + 200_000;
    const context = () => ({ deadline: Math.min(deadline, Date.now() + PUBLIC_PREPARATION_BUDGET_MS) });
    const publication = await runtime.preparePublication(1, context());
    if (publication.status !== 'preparing') throw new Error(publication.reason);
    const { job } = publication;
    const registration = await f.db.pool.query<{ definition: string }>(
      'SELECT definition FROM search.public_filter_registration WHERE partition_no=0 AND physical_target=$1',
      [target],
    );
    const retained = decodePublicFilterNativeState<{ data: { meaning: { release: unknown } } }>(
      registration.rows[0]!.definition,
    );
    expect(retained.data.meaning.release).toEqual({ authority: 'semantic.readRelease', digest: f.meaning.digest });
    let activate = false;
    let boundAttempts = 0;
    let acknowledged = 0;
    let last: { status: string; reason?: string; cost?: unknown } = { status: 'registered' };
    for (let turn = 0; turn < 500 && Date.now() < deadline; turn++) {
      if (!activate) {
        const step = await runtime.publication.step(job, context(), { enrollSource: true });
        last = { status: step.status, ...('reason' in step && { reason: step.reason }), cost: step.cost };
        activate = step.status === 'reconciled';
        continue;
      }
      const result = await runtime.publication.activate(job, context());
      last = { status: result.status, ...('reason' in result && { reason: result.reason }), cost: result.cost };
      if (result.status === 'preparing' && result.next === 'step') activate = false;
      const source = await f.db.pool.query<{
        state: string;
        observation: string;
        execution: string;
        root: boolean;
        ack_after: number;
        bootstrap: string;
      }>(
        `SELECT b.bootstrap::text,b.state,b.publication_observation AS observation,b.publication_execution AS execution,
                EXISTS(SELECT 1 FROM semantic.public_filter_repair_step r
                  WHERE (r.partition_no,r.bootstrap,r.execution)=(b.partition_no,b.bootstrap,b.publication_execution)
                  AND r.predecessor IS NULL) AS root,
                COALESCE(t.ack_after,0) AS ack_after
           FROM semantic.public_filter_bootstrap b
           LEFT JOIN semantic.public_filter_repair_step t
             ON (t.partition_no,t.bootstrap,t.execution)=(b.partition_no,b.bootstrap,b.publication_execution)
             AND t.complete AND t.verified_root IS NOT NULL AND t.verified_next IS NULL
          WHERE (b.partition_no,b.publication_job)=(0,$1::uuid)`,
        [job.job],
      );
      const original = source.rows[0];
      if (original?.state !== 'adopted') continue;
      expect(original.execution).toBe(job.job);
      expect(original.observation).toMatch(/^0:/);
      if (!original.root) {
        if (++boundAttempts === 8) break;
        continue;
      }
      const advanced = original.ack_after - acknowledged;
      expect(advanced).toBeGreaterThanOrEqual(0);
      expect(advanced).toBeLessThanOrEqual(PUBLIC_FILTER_REPAIR_ACK_BATCH_LIMIT);
      acknowledged = original.ack_after;
      if (advanced < 2) continue;
      expect(result).toMatchObject({ status: 'preparing', next: 'activate', advanced: true });
      expect(result.cost.inputKeys).toBeLessThanOrEqual(1000);
      const receipts = await f.db.pool.query<{ homes: number }>(
        `SELECT count(*)::int AS homes
         FROM search.public_filter_coverage_home h
         JOIN search.public_filter_coverage_baseline b
           ON (b.partition_no,b.registration,b.source_home,b.bootstrap)=
              (h.partition_no,h.registration,h.source_home,h.acknowledged_baseline)
         WHERE h.acknowledged_baseline=$1 AND h.acknowledged_observation=$2 AND h.acknowledged_execution=$3
           AND h.acknowledged_settlement IS NOT NULL AND h.source_home<$4
           AND h.acknowledged_position=b.source_position
           AND h.acknowledged_native_enqueue=b.native_enqueue_revision
           AND h.acknowledged_native_revision IS NOT DISTINCT FROM b.native_revision
           AND h.acknowledged_native_claim_revision IS NOT DISTINCT FROM b.native_claim_revision`,
        [original.bootstrap, original.observation, original.execution, acknowledged],
      );
      expect(receipts.rows[0]?.homes).toBe(acknowledged);
      const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
      const exhausted = await readNativePublicFilterPublicationCompletion(binding, { job: job.job }, context(), {
        inputKeys: 1000,
        bytes: 0,
      });
      expect(exhausted).toMatchObject({ status: 'unavailable', reason: 'owner_unavailable', cost: { inputKeys: 0 } });
      const frontier = await f.db.pool.query<{ ack_after: number }>(
        `SELECT ack_after FROM semantic.public_filter_repair_step
         WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND complete
           AND verified_root IS NOT NULL AND verified_next IS NULL`,
        [original.bootstrap, original.execution],
      );
      expect(frontier.rows).toEqual([{ ack_after: acknowledged }]);
      console.info(
        'Native original Source acknowledgement prefix',
        JSON.stringify({
          job: job.job,
          observation: original.observation,
          acknowledged,
          advanced,
          inputKeys: result.cost.inputKeys,
        }),
      );
      return;
    }
    const terminal = await f.db.pool.query<{
      phase: string;
      source_state: string | null;
      source_ordinal: string | null;
      source_complete: boolean | null;
      ack_after: number | null;
      repair_settlement: string | null;
    }>(
      `SELECT j.phase,b.state AS source_state,t.verified_ordinal::text AS source_ordinal,
              t.complete AS source_complete,t.ack_after,e.repair_settlement
       FROM search.generation_publication j
       LEFT JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.publication_job)=(0,j.job)
       LEFT JOIN semantic.public_filter_repair_step t
         ON (t.partition_no,t.bootstrap,t.execution)=(b.partition_no,b.bootstrap,b.publication_execution)
         AND t.verified_root IS NOT NULL AND t.verified_next IS NULL
       LEFT JOIN search.public_filter_execution e
         ON (e.partition_no,e.observation,e.id)=(0,b.publication_observation,b.publication_execution)
       WHERE (j.partition_no,j.job)=(0,$1)`,
      [job.job],
    );
    const { repair_settlement, ...source } = terminal.rows[0] ?? {};
    const settlement = repair_settlement
      ? decodePublicFilterNativeState<{ pages: number; closed: boolean; fence?: unknown }>(repair_settlement)
      : undefined;
    throw new Error(
      `Original Source repair did not acknowledge a batch: ${JSON.stringify({
        job: job.job,
        acknowledged,
        last,
        source,
        searchSettlement: settlement && {
          pages: settlement.pages,
          closed: settlement.closed,
          fenced: !!settlement.fence,
        },
      })}`,
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        await search.request('DELETE', `/${target}`);
      } finally {
        await f.close();
      }
    }
  }
}, 240_000);

test('publication repairs a newer settled Subject writer under its original Source acknowledgement', async () => {
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `source-renew-writer-${crypto.randomUUID().slice(0, 8)}-`;
  const target = subjectIndexName(prefix, 1);
  const runtime = createDefaultPublicFilterRuntime({ ...f.config, search, prefix });
  const context = () => ({ deadline: Date.now() + PUBLIC_PREPARATION_BUDGET_MS });
  try {
    const author = await f.create();
    const book = await f.create('schema:Book', { 'schema:author': [statement('schema:author', author)] });
    const home = partitionOf(routeOf(book)!);
    await createSubjectIndex(search, prefix, 1);
    const writer = createSearchWriterGuard({
      pool: f.db.pool,
      search,
      index: target,
      consumer: subjectConsumer(prefix, 1),
      source: createRatedSubjectSource(f.db.pool, f.config.routeKey).source,
      listing: subjectListingSource(f.db.pool),
    });
    for (const subject of [author, book]) await writer.write(partitionOf(routeOf(subject)!), [subject], 0n);
    const admitted = await runtime.preparePublication(1, context());
    if (admitted.status !== 'preparing') throw new Error(admitted.reason);
    const { job } = admitted;
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const completion = () => readNativePublicFilterPublicationCompletion(binding, { job: job.job }, context());
    const retained = async () =>
      (
        await f.db.pool.query(
          `SELECT j.bootstrap,j.observation,j.execution,t.step,t.verified_root,t.ack_after
       FROM search.generation_publication j
       LEFT JOIN semantic.public_filter_repair_step t ON (t.partition_no,t.bootstrap,t.execution)=(0,substring(j.bootstrap from 3)::uuid,j.execution)
         AND t.complete AND t.verified_root IS NOT NULL AND t.verified_next IS NULL
       WHERE (j.partition_no,j.job)=(0,$1)`,
          [job.job],
        )
      ).rows[0]!;
    const readWriter = async () =>
      (
        await f.db.pool.query(
          `SELECT writer_transaction_id,settled_transaction_id,repair_locator,repair_receipt
       FROM search.identity_writer WHERE (partition_no,physical_target,original_id)=($1,$2,$3)`,
          [home, target, book],
        )
      ).rows[0]!;
    const effect = async () =>
      (
        await f.db.pool.query(
          `SELECT page,item,receipt FROM search.public_filter_repair_effect
       WHERE (partition_no,observation,execution)=(0,$1,$2) ORDER BY page,item`,
          [(await retained()).observation, job.job],
        )
      ).rows;
    let next: 'step' | 'activate' = 'step';
    let original: Awaited<ReturnType<typeof retained>> | undefined;
    let historicalEffects: Awaited<ReturnType<typeof effect>> | undefined;
    let last: unknown;
    for (let turn = 0; turn < 900; turn++) {
      if (next === 'step') {
        const result = await runtime.publication.step(job, context(), { enrollSource: true });
        last = result;
        if (result.status === 'reconciled') next = 'activate';
        continue;
      }
      const result = await runtime.publication.activate(job, context());
      last = result;
      if (result.status === 'preparing') next = result.next;
      const proof = await retained();
      if (proof.ack_after > 0 && !original) {
        original = proof;
        historicalEffects = await effect();
        const first = await readWriter();
        expect(first.repair_receipt).toBeString();
        await writer.write(home, [book], 0n);
        const newer = await readWriter();
        expect(newer).toMatchObject({ repair_locator: first.repair_locator, repair_receipt: first.repair_receipt });
        expect(newer.writer_transaction_id).not.toBe(first.writer_transaction_id);
        expect((await completion()).status).toBe('pending');
        expect(await retained()).toEqual(original);
        expect((await subjectGenerations(search, prefix)).active).toBeNull();
        const historical = historicalEffects[0]!;
        const effectKey = [proof.observation, job.job, historical.page, historical.item];
        await f.db.pool.query(
          `DELETE FROM search.public_filter_repair_effect WHERE (partition_no,observation,execution,page,item)=(0,$1,$2,$3,$4)`,
          effectKey,
        );
        try {
          expect(await runtime.publication.activate(job, context())).toMatchObject({
            status: 'preparing',
            advanced: false,
          });
          expect(await readWriter()).toEqual(newer);
          expect(await retained()).toEqual(original);
        } finally {
          await f.db.pool.query(
            `INSERT INTO search.public_filter_repair_effect(partition_no,observation,execution,page,item,receipt) VALUES (0,$1,$2,$3,$4,$5)`,
            [...effectKey, historical.receipt],
          );
        }
        const renewed = await runtime.publication.activate(job, context());
        expect(renewed).toMatchObject({ status: 'preparing', advanced: true });
        const fresh = await readWriter();
        expect(fresh.repair_locator).toBe(first.repair_locator);
        expect(fresh.repair_receipt).not.toBe(first.repair_receipt);
        expect(fresh.writer_transaction_id).not.toBe(newer.writer_transaction_id);
        expect(await retained()).toEqual(original);
        expect(await effect()).toEqual(historicalEffects);
        const winner = (
          await search.request<{ _source: Record<string, unknown>; _version: number }>('GET', `/${target}/_doc/${book}`)
        ).body;
        const replaceWinner = async (document: Record<string, unknown>) => {
          const result = await search.bulk<{ errors: boolean }>(
            [
              { index: { _index: target, _id: book, version: winner._version, version_type: 'external_gte' } },
              document,
            ],
            { query: { refresh: 'wait_for' } },
          );
          expect(result).toMatchObject({ errors: false });
          expect((await search.request('GET', `/${target}/_doc/${book}`)).body).toMatchObject({ _source: document });
        };
        await replaceWinner({ ...winner._source, names: ['Wrong book'] });
        try {
          expect((await completion()).status).toBe('pending');
          expect(await retained()).toEqual(original);
          expect((await subjectGenerations(search, prefix)).active).toBeNull();
        } finally {
          await replaceWinner(winner._source);
        }
      }
      if (result.status === 'activated') {
        expect(original).toBeDefined();
        expect(proof).toEqual({ ...original, ack_after: 4096 });
        expect(await effect()).toEqual(historicalEffects);
        expect((await subjectGenerations(search, prefix)).active).toBe(1);
        return;
      }
    }
    throw new Error(`Subject renewal did not activate: ${JSON.stringify({ retained: await retained(), last })}`);
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        await search.request('DELETE', `/${target}`);
      } finally {
        await f.close();
      }
    }
  }
}, 420_000);
