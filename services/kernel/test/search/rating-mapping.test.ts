import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;

// These are already-published population scores. Their public-figure source is a separate contract.
// Do not add a fixture mapping: this suite must exercise the production index definition.
function lines(entries: [number, Record<string, unknown>][]): unknown[] {
  return entries.flatMap(([n, patch]) => {
    const subject: IndexedSubject = {
      id: id(n),
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: [{ language: 'en', value: 'Kokoro' }],
      aliases: [],
      descriptions: [],
      statements: [],
    };
    const actions = documentActions({ partition: 10, position: 11n, subjects: [subject] }, [subject.id]);
    return bulkLines(
      index,
      actions.map((action) =>
        action.op === 'index' ? { ...action, document: { ...action.document, ...patch } } : action,
      ),
    );
  });
}

type BulkResult = {
  errors: boolean;
  items: { index: { status: number; error?: { type: string; reason: string } } }[];
};
type MappingResult = Record<
  string,
  { mappings: { dynamic: string; properties: Record<string, Record<string, unknown>> } }
>;
type SearchResult = {
  hits: {
    hits: {
      _id: string;
      _version: number;
      _source: Record<string, unknown>;
      fields?: { rating_score?: number[] };
    }[];
  };
};

beforeAll(async () => {
  await createSubjectIndex(search, prefix, 1);
});
afterAll(async () => {
  await search.request('DELETE', `/${index}`).catch(() => undefined);
});

test('production rating_score is a strict double with doc values and no coercion', async () => {
  const response = await search.request<MappingResult>('GET', `/${index}/_mapping`);
  const mapping = response.body[index]!.mappings;
  expect(mapping.dynamic).toBe('strict');
  expect(mapping.properties.rating_score).toMatchObject({ type: 'double', doc_values: true, coerce: false });
  expect(mapping.properties.rating_score).not.toHaveProperty('null_value');
  expect(mapping.properties.names).toMatchObject({ type: 'text', analyzer: 'cjk_bigram_v2' });
  expect(mapping.properties.partition).toMatchObject({ type: 'integer' });
  expect(mapping.properties.security_revision).toMatchObject({ type: 'long' });
});

test('published zero and decimal scores are visible while null and missing remain unscored', async () => {
  const result = await search.bulk<BulkResult>(
    lines([
      [1, { rating_score: 0 }],
      [2, { rating_score: 7.625 }],
      [3, { rating_score: null }],
      [4, {}],
    ]),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
  expect(result.items.map((item) => item.index.status)).toEqual([201, 201, 201, 201]);
  const visible = await search.request<SearchResult>('POST', `/${index}/_search`, {
    size: 4,
    version: true,
    query: { match: { names: 'ＫＯＫＯＲＯ' } },
    sort: [{ id: 'asc' }],
    docvalue_fields: ['rating_score'],
  });
  expect(visible.body.hits.hits.map((hit) => hit._id)).toEqual([id(1), id(2), id(3), id(4)]);
  for (const hit of visible.body.hits.hits) {
    expect(hit._version).toBe(11);
    expect(hit._source).toMatchObject({
      id: hit._id,
      partition: 10,
      type: 'schema:Book',
      security_revision: 1,
      names: ['Kokoro'],
      name_sort: 'Kokoro',
    });
  }
  expect(visible.body.hits.hits.map((hit) => hit._source.rating_score)).toEqual([0, 7.625, null, undefined]);
  expect(visible.body.hits.hits.map((hit) => hit.fields?.rating_score ?? [])).toEqual([[0], [7.625], [], []]);
  const scored = await search.request<SearchResult>('POST', `/${index}/_search`, {
    query: { exists: { field: 'rating_score' } },
    sort: [{ id: 'asc' }],
  });
  expect(scored.body.hits.hits.map((hit) => hit._id)).toEqual([id(1), id(2)]);
});

test('numeric strings are rejected by the rating_score mapper rather than coerced', async () => {
  const result = await search.bulk<BulkResult>(lines([[5, { rating_score: '7.625' }]]));
  expect(result.errors).toBe(true);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]!.index).toMatchObject({
    status: 400,
    error: { type: 'mapper_parsing_exception' },
  });
  expect(result.items[0]!.index.error!.reason).toContain('rating_score');
});

test('the public subject mapping rejects extra voter and private population structures', async () => {
  const result = await search.bulk<BulkResult>(
    lines([
      [6, { votes: [{ voter_id: id(9), score: 8 }] }],
      [7, { private_populations: [{ realm_id: id(10), score: 7.625 }] }],
      [8, { voter: { id: id(9), realm_id: id(10) } }],
    ]),
  );
  expect(result.errors).toBe(true);
  expect(result.items).toHaveLength(3);
  for (const item of result.items) {
    expect(item.index).toMatchObject({ status: 400, error: { type: 'strict_dynamic_mapping_exception' } });
  }
});
