import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createPublicFilterCustody } from '../../src/search/public-filter-custody.ts';
import {
  createSearchGenerationPublication,
  type SearchGenerationPublicationConfig,
} from '../../src/search/generation-publication.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName, subjectGenerations } from '../../src/search/indices.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { readHeldCommandRange } from '../../src/semantic/public-filter-held-command-range.ts';
import { createSubjectSourceKeyPages } from '../../src/semantic/subject-source-key-pages.ts';
import {
  createPublicFilterSourceBinding,
  readNativePublicFilterPublicationCompletion,
} from '../../src/semantic/public-filter-source-binding.ts';
import { retainNativePublicFilterMeaning } from '../../src/search/public-filter-meaning.ts';
import { hasVerifiedReleaseDigest, readRelease } from '../../src/semantic/definition-release-read.ts';
import { createIdentityRegistrar } from '../support/identity-registration.ts';
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

test('the receiver commits the original all-home ACK over verified compact windows', async () => {
  const isolated = await identityEpochDatabase();
  try {
    await verifyPublication(isolated.url, true);
  } finally {
    await isolated.close();
  }
}, 180000);

async function verifyPublication(url: string, verifyCompactWindow = false) {
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
  const sourceKeys = createSubjectSourceKeyPages(pool, f.config.routeKey, f.config.access);
  const quietCommand = (partition: number) =>
    runCommand(pool, { partition }, async () => ({
      value: null,
      events: [{ type: 'com.rezics.fixture.created.v1', data: null }],
    }));
  let proofReads: number | undefined;
  const publicationConfig: SearchGenerationPublicationConfig = {
    subjectSubscriptionProtocol: 1,
    pool,
    search,
    source,
    binding,
    sourceKeys: {
      async read(request, context) {
        const page = await sourceKeys.read(request, context);
        if (request.partition === 47 && proofReads !== undefined && ++proofReads === 1) await quietCommand(47);
        return page;
      },
    },
    readPublicationCompletion: (request, ctx) => readNativePublicFilterPublicationCompletion(binding, request, ctx),
    clock: f.config.clock,
    meaning: retainNativePublicFilterMeaning({ digest: f.meaning.digest, release }, hasVerifiedReleaseDigest),
    writerGuard: writer,
  };
  let publication = createSearchGenerationPublication(publicationConfig);
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
    const second = verifyCompactWindow ? await book(47) : undefined;
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

    if (verifyCompactWindow) {
      expect((await pool.query('SELECT FROM semantic.subject_access_page_v1 WHERE birth=$1', [birth])).rowCount).toBe(
        0,
      );
      // A full 64-home ACK has nonzero bases and a later committed singleton in every home.
      for (let home = 64; home < 128; home++) await quietCommand(home);
      const base = await position(70);
      await writer.write(0, [resident], await position(0));
      await writer.write(47, [second!], await position(47));
      await search.request('POST', '/' + target + '/_refresh');
      let reconciled = false;
      let cleanLeaf: string | undefined;
      let splitLeaf = false;
      const readAckPrefix = () =>
        pool.query<{ first_home: number; width: number; revision: string }>(
          `WITH basis AS MATERIALIZED (SELECT search.public_filter_ack_basis_v1(true) AS value)
         SELECT n.first_home,n.width,n.revision FROM search.public_filter_ack_range n,basis
         WHERE n.job=$1 AND (n.first_home,n.width) IN ((0,32),(32,32),(0,64))
           AND n.witness=search.public_filter_ack_range_witness(n.bootstrap,n.first_home,n.width,basis.value)
         ORDER BY n.width,n.first_home`,
          [prepared.job.job],
        );
      for (let turn = 0; turn < 512; turn++) {
        if (!reconciled) {
          const result = await publication.step(prepared.job, context(), { enrollSource: true, batchSource: true });
          if ('reason' in result) throw new Error(result.reason);
          reconciled = result.status === 'reconciled';
          if (reconciled) for (let home = 64; home < 128; home++) await quietCommand(home);
          continue;
        }
        const activation = await publication.activate(prepared.job, context(), { batchSource: true });
        if (activation.status !== 'preparing' && activation.status !== 'activated')
          throw new Error('reason' in activation ? activation.reason : activation.status);
        if (!cleanLeaf) {
          const { rows } = await readAckPrefix();
          if (rows.length === 3) {
            cleanLeaf = rows[0]!.revision;
            // An interior cleanup changes this page and its parents in the original binding.
            await pool.query('SELECT core.advance_subject_cleanup_v1(45)');
            expect((await readAckPrefix()).rows).toEqual([rows[0]!]);
          }
        }
        if (!splitLeaf) {
          // A registration behind the verified frontier invalidates a compact ACK and its ancestors.
          const compact = await pool.query(
            'SELECT 1 FROM search.public_filter_ack_range WHERE job=$1 AND first_home=512 AND width=512 AND left_child IS NULL',
            [prepared.job.job],
          );
          if (compact.rowCount) {
            await createIdentityRegistrar(pool, f.config.routeKey).registerActor('late-member', newId(512 * 16));
            const offer = await pool.query('SELECT * FROM search.prepare_subject_ack_prefix_v1($1,824,868352)', [
              prepared.job.job,
            ]);
            expect(offer.rows[0].range_writes).toBeGreaterThan(0);
            expect(offer.rows[0].points).toBeLessThanOrEqual(824);
            expect(offer.rows[0].proof_bytes).toBeLessThanOrEqual(868352);
            const leaf = await pool.query(
              'SELECT width FROM search.public_filter_ack_range WHERE job=$1 AND first_home=512 AND width<32',
              [prepared.job.job],
            );
            expect(leaf.rows).toContainEqual({ width: 16 });
            await publication.close();
            publication = createSearchGenerationPublication(publicationConfig);
            splitLeaf = true;
          }
        }
        const proof = (
          await pool.query(
            `SELECT r.width,r.first_home,m.root_digest=r.digest AS matched,t.ack_after,m.ordinal::integer AS steps,
             m.committed_by IS DISTINCT FROM pg_current_xact_id_if_assigned() AS independent,
             (SELECT count(*)::integer FROM search.public_filter_ack_range n
               WHERE n.job=m.job AND n.width>32 AND n.left_child IS NULL) AS compact_nodes,
             (SELECT max(width) FROM search.public_filter_ack_range n
               WHERE n.job=m.job AND n.width>32 AND n.left_child IS NULL) AS compact_width
           FROM search.public_filter_ack_manifest m
           JOIN search.public_filter_ack_range r ON (r.job,r.binding,r.revision)=(m.job,m.binding,m.root_revision)
           JOIN semantic.public_filter_repair_step t ON
             (t.partition_no,t.bootstrap,t.execution,t.step)=(0,m.bootstrap,m.execution,m.terminal)
           WHERE m.job=$1 AND t.ack_after=4096`,
            [prepared.job.job],
          )
        ).rows[0];
        if (!proof) continue;
        expect(splitLeaf).toBe(true);
        expect(proof).toMatchObject({ first_home: 0, width: 4096, matched: true, independent: true, ack_after: 4096 });
        expect(proof.compact_nodes).toBeGreaterThan(0);
        expect(proof.compact_width).toBeGreaterThan(32);
        const compared = await pool.query(
          `SELECT w.base,w.through_pos,s.bootstrap,
              search.public_filter_ack_field(batch,'count')::int AS count,
              search.public_filter_ack_field(batch,'commandEnds')#>>'{}' AS ends FROM search.public_filter_ack_range n
           JOIN semantic.public_filter_repair_step s ON (s.bootstrap,s.execution,s.verified_binding,s.verified_home)=
             (n.bootstrap,n.job::text,n.binding,64)
           CROSS JOIN LATERAL (SELECT search.public_filter_ack_field(s.state::jsonb->1,'windowBatch') AS batch) source
           CROSS JOIN LATERAL search.subject_ack_windows_v1(s.state,70,71) w
           WHERE n.job=$1 AND n.first_home=64 AND n.width=64 AND n.left_child IS NULL`,
          [prepared.job.job],
        );
        expect(compared.rows).toHaveLength(1);
        const original = compared.rows[0]!;
        expect(original).toMatchObject({ base: String(base), through_pos: String(base + 1n) });
        const reopen = () =>
          readHeldCommandRange(
            pool,
            { start: 64, birth, bootstrap: original.bootstrap },
            context().deadline,
            { rows: 0, inputKeys: 0, dependencyPoints: 0 },
            { count: original.count, commandEnds: original.ends },
          );
        const sealed = await reopen();
        await runCommand(pool, { partition: 70 }, async () => ({
          value: null,
          events: Array.from({ length: 2 }, () => ({ type: 'com.rezics.fixture.created.v1', data: null })),
        }));
        const current = await readHeldCommandRange(
          pool,
          { start: 64, birth, bootstrap: original.bootstrap },
          context().deadline,
          { rows: 0, inputKeys: 0, dependencyPoints: 0 },
        );
        expect(current.digests).toHaveLength(0);
        expect(await reopen()).toEqual(sealed);
        await pool.query('SELECT core.advance_subject_cleanup_v1(73)');
        await expect(reopen()).rejects.toThrow();
        expect(await reopen()).toEqual(sealed);
        const extended = (await readAckPrefix()).rows;
        expect(extended).toHaveLength(3);
        if (cleanLeaf === undefined) throw new Error('Missing original clean leaf');
        expect(extended[0]!.revision).toBe(cleanLeaf);

        // A real command advances an occupied home between the two sparse cuts.
        // The same drained writer must retry against the original completed Source.
        proofReads = 0;
        let retryFence: string | undefined;
        for (let offer = 0; offer < 32; offer++) {
          const result = await publication.activate(prepared.job, context(), { batchSource: true });
          if (result.status === 'activated') {
            expect(proofReads).toBe(2);
            expect(retryFence).toBeString();
            expect((await subjectGenerations(search, prefix)).active).toBe(1);
            return;
          }
          expect(result).toMatchObject({ status: 'preparing', next: 'activate' });
          if (proofReads) {
            const job = (
              await pool.query(
                'SELECT phase,pass,fence,subject_fenced_cut FROM search.generation_publication WHERE job=$1',
                [prepared.job.job],
              )
            ).rows[0];
            if (proofReads === 1) {
              expect(job).toMatchObject({ phase: 'fencing', pass: '1', subject_fenced_cut: null });
              expect((await subjectGenerations(search, prefix)).active).toBeNull();
              retryFence = job.fence;
            } else {
              expect(job).toMatchObject({ phase: 'intent', pass: '2', fence: retryFence });
              expect(job.subject_fenced_cut).toHaveLength(32);
            }
          }
        }
        throw new Error('Drained publication did not activate');
      }
      throw new Error('Original publication did not acknowledge all 4096 homes');
    }

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
    ).toEqual([{ end_home: 34 }]);
    expect(await frontier()).toEqual({ next_home: 2, next_ordinal: 1 });
    for (const partition of [2, 3])
      await runCommand(pool, { partition }, async () => ({
        value: null,
        events: [{ type: 'com.rezics.fixture.created.v1', data: null }],
      }));
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    // Receiver adoption commits separately from the producer's finite window.
    expect(await frontier()).toEqual({ next_home: 2, next_ordinal: 1 });
    expect(await step()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    expect(await frontier()).toEqual({ next_home: 34, next_ordinal: 0 });
    const window = await pool.query(
      'SELECT evidence FROM semantic.subject_source_step_v1 WHERE (birth,first_home,ordinal)=($1,2,1)',
      [birth],
    );
    expect(window.rows[0].evidence.evidence.quiet.map(([home]: [number, unknown]) => home)).toEqual([2, 3]);
    const batch = () =>
      publication.step(prepared.job, context(), { enrollSource: true, batchSource: true, heldOffers: 9 });
    const grouped = await batch();
    expect(grouped.status).toBe('progress');
    if (grouped.status !== 'progress') throw new Error('Missing grouped enrollment');
    const offers = [grouped.cost, ...(grouped.additionalEnrollmentCosts ?? [])];
    expect(offers.length).toBeLessThanOrEqual(9);
    expect(offers.every((offer) => offer.inputKeys <= 1000)).toBe(true);
    expect(await frontier()).toEqual({ next_home: 98, next_ordinal: 0 });
    const pages = (
      await pool.query(
        `SELECT a.first_home,a.end_home,a.captured_xid::text,r.adopted_by::text FROM semantic.subject_access_page_v1 a
       JOIN search.subject_receiver_page_v1 r USING(birth,first_home,end_home)
       WHERE a.birth=$1 AND a.first_home>=34 ORDER BY a.first_home`,
        [birth],
      )
    ).rows;
    expect(pages.map((p) => [p.first_home, p.end_home])).toEqual([
      [34, 66],
      [66, 98],
    ]);
    expect(pages[0]!.captured_xid).toBe(pages[1]!.captured_xid);
    expect(pages.every((p) => p.adopted_by !== p.captured_xid)).toBe(true);
    // Lose the receiver reply before Source accepts its original.
    await pool.query('SELECT semantic.capture_subject_access_page_v1($1,98,100)', [birth]);
    await pool.query('SELECT search.adopt_subject_receiver_page_v1($1,98)', [birth]);
    expect(await batch()).toMatchObject({ status: 'progress', sourceAdvanced: true });
    const accepted = await pool.query(
      'SELECT b.coverage_after FROM semantic.public_filter_bootstrap b JOIN core.subject_subscription_v1 m USING(bootstrap) WHERE m.birth=$1',
      [birth],
    );
    expect(accepted.rows[0]?.coverage_after).toBe(100);
    const original = await frontier();
    const capture = await publication.step(prepared.job, context(), {
      enrollSource: true,
      batchSource: true,
      heldLane: 'capture',
      heldOffers: 5,
    });
    expect(capture.status).toBe('progress');
    expect(await frontier()).toEqual(original);
    expect(
      (await pool.query('SELECT max(end_home) AS covered FROM search.subject_receiver_page_v1 WHERE birth=$1', [birth]))
        .rows[0]?.covered,
    ).toBe(164);
    const scan = await publication.step(prepared.job, context(), {
      enrollSource: true,
      batchSource: true,
      heldLane: 'source',
      heldOffers: 9,
    });
    expect(scan.status).toBe('progress');
    expect(await frontier()).toEqual({ next_home: 164, next_ordinal: 0 });
    for (const [result, slots] of [
      [capture, 5],
      [scan, 9],
    ] as const) {
      if (result.status !== 'progress') throw new Error('Missing held enrollment progress');
      const costs = [result.cost, ...(result.additionalEnrollmentCosts ?? [])];
      expect(costs.length).toBeLessThanOrEqual(slots);
      expect(costs.every((cost) => cost.inputKeys <= 1000)).toBe(true);
    }
    const emptySteps = await pool.query(
      `SELECT first_home,ordinal,evidence->'complete' AS complete,
         jsonb_array_length(evidence->'evidence'->'windows') AS windows
       FROM semantic.subject_source_step_v1 WHERE birth=$1 AND first_home>=100 ORDER BY first_home,ordinal`,
      [birth],
    );
    expect(emptySteps.rows).toEqual([
      { first_home: 100, ordinal: 0, complete: true, windows: 32 },
      { first_home: 132, ordinal: 0, complete: true, windows: 32 },
    ]);
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
