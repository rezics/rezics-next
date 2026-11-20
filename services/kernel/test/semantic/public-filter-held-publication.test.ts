import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { anchorRoute, partitionOf, routeOf } from '../../src/route/route.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import { createSearchGenerationPublication } from '../../src/search/generation-publication.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { retainNativePublicFilterMeaning } from '../../src/search/public-filter-meaning.ts';
import { hasVerifiedReleaseDigest, readRelease } from '../../src/semantic/definition-release-read.ts';
import { identityEpochDatabase } from './support/identity-epoch.ts';
import { fixture, nativeProducer } from './support/public-filter-source.ts';

test('the cold publication step reconciles original inventory and a later withdrawal through the ordinary writer', async () => {
  const isolated = await identityEpochDatabase();
  try {
    await verifyPublication(isolated.url);
  } finally {
    await isolated.close();
  }
}, 60000);

async function verifyPublication(url: string) {
  const f = await fixture(url);
  const pool = f.db.pool;
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = 'source-held-' + randomUUID().slice(0, 8) + '-';
  const target = subjectIndexName(prefix, 1);
  const custody = createPublicFilterCustody(pool);
  const source = (await nativeProducer()).publicFilterSource(f.config);
  const binding = createPublicFilterSourceBinding(pool, f.config.routeKey, f.config.access);
  const writer = createSearchWriterGuard({
    pool,
    search,
    index: target,
    consumer: subjectConsumer(prefix, 1),
    source: createRatedSubjectSource(pool, f.config.routeKey).source,
    listing: subjectListingSource(pool),
  });
  const release = await readRelease(pool, f.meaning.digest);
  if (!release) throw new Error('Missing original publication meaning');
  const publication = createSearchGenerationPublication({
    subjectSubscriptionProtocol: 1,
    pool,
    search,
    source,
    binding,
    sourceKeys: createSubjectSourceKeyPages(pool, f.config.routeKey, f.config.access),
    readPublicationCompletion: (request, ctx) => readNativePublicFilterPublicationCompletion(binding, request, ctx),
    clock: f.config.clock,
    meaning: retainNativePublicFilterMeaning({ digest: f.meaning.digest, release }, hasVerifiedReleaseDigest),
    writerGuard: writer,
  });
  const context = () => ({ deadline: Date.now() + 10000 });
  const book = async (partition: number) => {
    let key: string;
    do {
      key = randomUUID();
    } while (
      partitionOf(anchorRoute(f.config.routeKey, [f.accounts.editor, 'subject.create', key].join('\n'))) !== partition
    );
    const id = await f.create('schema:Book', {}, key);
    expect(partitionOf(routeOf(id)!)).toBe(partition);
    return id;
  };
  const position = async (home: number) =>
    BigInt((await pool.query('SELECT position FROM core.partition WHERE partition_no=$1', [home])).rows[0].position);
  try {
    await createSubjectIndex(search, prefix, 1);
    const resident = await book(0);
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
      context(),
    );
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const registration = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: target,
        consumerGeneration: '1',
        projectionGeneration: resolved.definition.readDefinition,
      },
      search,
      context(),
    );
    if (registration.status !== 'registered') throw new Error(registration.reason);
    await pool.query('SELECT core.enable_subject_retention_v1()');
    const prepared = await publication.prepare(registration.consumer, context());
    if (prepared.status !== 'preparing') throw new Error(prepared.reason);
    const step = () => publication.step(prepared.job, context(), { enrollSource: true });
    const { birth } = (
      await pool.query('SELECT birth FROM core.subject_subscription_v1 WHERE job=$1', [prepared.job.job])
    ).rows[0];

    await pool.query('SELECT semantic.capture_subject_access_page_v1($1,0,2)', [birth]);
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    expect(
      (await pool.query('SELECT first_home,end_home FROM search.subject_receiver_page_v1 WHERE birth=$1', [birth]))
        .rows,
    ).toEqual([{ first_home: 0, end_home: 2 }]);
    const frontier = async () =>
      (
        await pool.query('SELECT next_home,next_ordinal FROM semantic.subject_source_preparation_v1 WHERE birth=$1', [
          birth,
        ])
      ).rows[0];
    expect(await step()).toMatchObject({ status: 'unready', reason: 'source_pending' });
    expect(await frontier()).toEqual({ next_home: 0, next_ordinal: 0 });
    await writer.write(0, [resident], await position(0));
    await search.request('POST', '/' + target + '/_refresh');
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    const late = await book(1);
    await f.post('/v1/subjects/' + late + ':hide', { reason: 'Withdrawn during cold preparation' });
    await writer.write(1, [late], await position(1));
    await search.request('POST', '/' + target + '/_refresh');
    for (let turn = 0; turn < 12 && (await frontier()).next_home === 0; turn++)
      expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    expect(await frontier()).toEqual({ next_home: 2, next_ordinal: 0 });
    // Continue from the retained short page using the ordinary page planner.
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    expect(
      (
        await pool.query('SELECT end_home FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=($1,2)', [
          birth,
        ])
      ).rows,
    ).toEqual([{ end_home: 10 }]);
    expect(await frontier()).toEqual({ next_home: 2, next_ordinal: 1 });
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    expect(await frontier()).toEqual({ next_home: 10, next_ordinal: 0 });
    const { body } = await search.request<{ hits: { hits: { _id: string }[] } }>('POST', '/' + target + '/_search', {
      query: { match_all: {} },
    });
    expect(body.hits.hits.map((hit) => hit._id)).toEqual([resident]);
    expect((await subjectGenerations(search, prefix)).active).toBeNull();
  } finally {
    await publication.close();
    await custody.close();
    try {
      await search.request('DELETE', '/' + target);
    } finally {
      await f.close();
    }
  }
}
