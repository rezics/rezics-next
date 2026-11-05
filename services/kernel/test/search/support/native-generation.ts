import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { SubjectSourceKeyPages } from '../../../src/semantic/subject-source-key-pages.ts';
import { subjectListingSource } from '../../../src/library/listing-counts.ts';
import { documentActions, validateIndexObservation } from '../../../src/search/document.ts';
import { prepareBoundedSortKeys } from '../../../src/search/bounded-sort-keys.ts';
import { assertNativeGenerationActionsVisible } from '../../../src/search/generations.ts';
import { readSearchWriterPhysicalTarget } from '../../../src/search/identity-epoch-participant-physical.ts';
import { readSubjectCalendarMappingFormatForIndex } from '../../../src/search/indices.ts';
import type { OpenSearch } from '../../../src/search/opensearch.ts';
import type { SubjectSource } from '../../../src/search/source.ts';

/** Receiving oracle only: read the existing native adapters and engine, never write or certify a target. */
export async function assertNativeGenerationCoverage(options: {
  pool: Pool;
  search: OpenSearch;
  index: string;
  source: SubjectSource;
  keys: SubjectSourceKeyPages;
}) {
  const { pool, search, index, source, keys } = options;
  const physical = await readSearchWriterPhysicalTarget(search, index);
  const calendar = await readSubjectCalendarMappingFormatForIndex(search, index);
  const listing = subjectListingSource(pool);
  const expected = new Set<string>();
  for (let partition = 0; partition < 4096; partition++) {
    let after: Parameters<SubjectSourceKeyPages['read']>[0]['after'] = null;
    for (;;) {
      const page = await keys.read({ partition, after, inputLimit: 50 }, { deadline: Date.now() + 30_000 });
      assert(page.status === 'eligible', `Native key page did not complete home ${partition}: ${page.status}`);
      if (page.ids.length) {
        const snapshot = await source.read(partition, page.ids);
        validateIndexObservation(snapshot, partition, page.ids, page.position);
        const counts = await listing.read(partition, page.ids);
        const actions = await prepareBoundedSortKeys(
          search,
          index,
          documentActions(snapshot, page.ids, counts, calendar ?? undefined),
        );
        const copies = (
          await pool.query<{
            original_id: string;
            incarnation: string;
            writer_token: string | null;
            dispatch_state: string;
            source_position: string;
          }>(
            `SELECT original_id::text,incarnation,writer_token,dispatch_state,source_position::text
            FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=ANY($3::uuid[])`,
            [partition, index, page.ids],
          )
        ).rows;
        assert.equal(copies.length, page.ids.length);
        const versions = new Map(
          copies.map((copy) => {
            assert.equal(copy.incarnation, physical.incarnation);
            assert.equal(copy.writer_token, null);
            assert.equal(copy.dispatch_state, 'settled');
            return [copy.original_id, BigInt(copy.source_position)] as const;
          }),
        );
        await assertNativeGenerationActionsVisible(
          search,
          index,
          actions.map((action) => ({ ...action, version: versions.get(action.id)! })),
        );
        for (const action of actions) if (action.op === 'index') expected.add(action.id);
      }
      if (page.complete) break;
      after = page.after;
    }
  }
  const actual = new Set<string>();
  type EnginePage = {
    _scroll_id: string;
    timed_out: boolean;
    _shards: { failed: number };
    hits: { hits: { _id: string }[] };
  };
  let scroll: string | undefined;
  try {
    let response = await search.request<EnginePage>(
      'POST',
      `/${index}/_search`,
      { size: 100, sort: ['_doc'] },
      { query: { scroll: '1m', allow_partial_search_results: false } },
    );
    for (;;) {
      scroll = response.body._scroll_id;
      assert.equal(response.status, 200);
      assert.equal(response.body.timed_out, false);
      assert.equal(response.body._shards.failed, 0);
      const rows = response.body.hits.hits;
      if (!rows.length) break;
      for (const row of rows) {
        assert(!actual.has(row._id));
        actual.add(row._id);
      }
      response = await search.request<EnginePage>('POST', '/_search/scroll', { scroll: '1m', scroll_id: scroll });
    }
  } finally {
    if (scroll) await search.request('DELETE', '/_search/scroll', { scroll_id: [scroll] });
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(await readSearchWriterPhysicalTarget(search, index), physical);
  return { nativeKeys: expected.size, engineKeys: actual.size, homes: 4096 };
}
