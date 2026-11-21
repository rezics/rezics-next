import { expect, test } from 'bun:test';
import { anchorRoute, partitionOf } from '../../src/route/route.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { identityEpochDatabase } from '../semantic/support/identity-epoch.ts';
import { fixture, nativeProducer, readContext } from '../semantic/support/public-filter-source.ts';

test('publication settles a rejected ordinary bulk under its original receipt before advancing the home', async () => {
  const database = await identityEpochDatabase();
  try {
    await verifyRecovery(database.url);
  } finally {
    await database.close();
  }
}, 60000);

async function verifyRecovery(url: string) {
  const f = await fixture(url);
  const { pool } = f.db;
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = 'relay-recovery-' + crypto.randomUUID().slice(0, 8) + '-';
  const index = subjectIndexName(prefix, 1);
  const writer = {
    pool,
    search,
    index,
    consumer: subjectConsumer(prefix, 1),
    source: createRatedSubjectSource(pool, f.config.routeKey).source,
    listing: subjectListingSource(pool),
  };
  const binding = createPublicFilterSourceBinding(pool, f.config.routeKey, f.config.access);
  const source = (await nativeProducer()).publicFilterSource(f.config);
  const custody = createPublicFilterCustody(pool);
  const publication = createSearchGenerationPublication({
    pool,
    search,
    source,
    binding,
    meaning: f.meaning,
    clock: f.config.clock,
    sourceKeys: createSubjectSourceKeyPages(pool, f.config.routeKey, f.config.access),
    readPublicationCompletion: (request, context) =>
      readNativePublicFilterPublicationCompletion(binding, request, context),
    writerGuard: createSearchWriterGuard(writer),
  });
  try {
    const home = 25;
    let key: string;
    do {
      key = crypto.randomUUID();
    } while (
      partitionOf(anchorRoute(f.config.routeKey, [f.accounts.editor, 'subject.create', key].join('\n'))) !== home
    );
    const id = await f.create('schema:Book', {}, key);
    await createSubjectIndex(search, prefix, 1);
    const resolved = await binding.resolve(
      {
        source,
        meaning: f.meaning,
        capture: {
          sort: 'id',
          size: 1,
          catalogueCoverage: true,
          catalogueNameSort: true,
          filterDocument: undefined,
          text: undefined,
        },
      },
      readContext(),
    );
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const registration = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: resolved.definition.readDefinition,
      },
      search,
      readContext(),
    );
    if (registration.status !== 'registered') throw new Error(registration.reason);
    const prepared = await publication.prepare(registration.consumer, readContext());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const job = prepared.job.job;
    // Resume at the open second Subject pass. All writer transitions and subsequent frontier changes are native.
    await pool.query('UPDATE search.generation_publication SET home=$2,pass=2 WHERE job=$1', [job, home]);
    const state = async () =>
      (await pool.query('SELECT phase,home,pass,revision FROM search.generation_publication WHERE job=$1', [job]))
        .rows[0];
    const receipt = async () =>
      (
        await pool.query(
          `SELECT writer_token,writer_transaction_id,writer_position,dispatch_state,source_position,
       visible_transaction_id,settled_transaction_id,visible_position,relay_receipt,relay_intent,relay_rejected_action
       FROM search.identity_writer WHERE partition_no=$1 AND original_id=$2 AND physical_target=$3`,
          [home, id, index],
        )
      ).rows[0];
    const hits = async () =>
      (
        await search.request<{ hits: { hits: { _index: string; _id: string; _version: number; _source: unknown }[] } }>(
          'POST',
          '/' + index + '/_search',
          { version: true, query: { ids: { values: [id] } } },
        )
      ).body.hits.hits;
    let original: readonly unknown[] | undefined;
    const failedRelay = createSearchWriterGuard({
      ...writer,
      recoverRelayEnrollment: true,
      search: {
        ...search,
        async bulk(lines) {
          original = lines;
          throw new OpenSearchError(429, {
            error: {
              type: 'circuit_breaking_exception',
              reason: '[in_flight_requests] Data too large, data for [<http_request>]',
            },
          });
        },
      },
    });
    await expect(createSubjectIndexer({ ...writer, writer: failedRelay }).run(home)).rejects.toThrow('HTTP 429');
    const dispatched = await receipt();
    expect(dispatched).toMatchObject({
      dispatch_state: 'dispatched',
      writer_token: expect.any(String),
      visible_transaction_id: null,
    });
    expect(JSON.parse(dispatched.relay_rejected_action).rejected).toBe('http_request');
    expect(await hits()).toEqual([]);
    const before = await state();
    const step = () => publication.step(prepared.job, readContext());
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    const settled = await receipt();
    expect(settled).toMatchObject({
      writer_token: null,
      writer_transaction_id: dispatched.writer_transaction_id,
      writer_position: dispatched.writer_position,
      dispatch_state: 'settled',
      visible_transaction_id: expect.any(String),
      relay_receipt: null,
      relay_rejected_action: null,
      relay_intent: null,
    });
    expect(settled.visible_transaction_id).toBe(settled.settled_transaction_id);
    expect(BigInt(settled.visible_position)).toBeGreaterThan(BigInt(settled.source_position));
    const version = (original![0] as { index: { version: number } }).index.version;
    expect(settled.source_position).toBe(String(version));
    expect(await hits()).toEqual([
      expect.objectContaining({ _index: index, _id: id, _version: version, _source: original![1] }),
    ]);
    expect(await state()).toMatchObject({ phase: 'subject', home });
    expect(await step()).toMatchObject({ status: 'progress' });
    const after = await state();
    expect(after).toMatchObject({ phase: 'engine', home: 0, pass: before.pass });
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  } finally {
    await publication.close();
    await custody.close();
    await search.request('DELETE', '/' + index, undefined, { query: { ignore_unavailable: true } });
    await f.close();
  }
}
