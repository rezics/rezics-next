import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { MAX_RELATION_FACET_VALUES, type IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const bookId = id(1);
const targetId = id(2);
const authorProperty = 'schema:author';
const roleProperty = 'schema:role';
const lead = id(3);
const support = id(4);
const authors = [targetId, ...Array.from({ length: MAX_RELATION_FACET_VALUES - 1 }, (_, index) => id(index + 100))];
const sampledAuthor = authors.at(-1)!;

const subject = (
  subjectId: string,
  statements: IndexedSubject['statements'],
  relationFacetOverflow?: string[],
): IndexedSubject => ({
  id: subjectId,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements,
  ...(relationFacetOverflow === undefined ? {} : { relationFacetOverflow }),
});

const sampledStatements: IndexedSubject['statements'] = authors.map((author, index) => ({
  property: authorProperty,
  value: author,
  facet: { kind: 'item' },
  ...(index === 0
    ? { qualifiers: [{ property: roleProperty, value: support }] }
    : index === MAX_RELATION_FACET_VALUES - 1
      ? { qualifiers: [{ property: roleProperty, value: lead }] }
      : {}),
}));
const book = subject(bookId, sampledStatements, [authorProperty, authorProperty]);
const target = subject(targetId, []);

beforeAll(async () => {
  await createSubjectIndex(search, prefix, 1);
  await search.bulk(
    bulkLines(index, documentActions({ partition: 10, position: 11n, subjects: [book, target] }, [bookId, targetId])),
    { query: { refresh: 'wait_for' } },
  );
});
afterAll(async () => {
  await search.request('DELETE', `/${index}`).catch(() => undefined);
});

type SearchResult = { hits: { hits: { _id: string; _source?: Record<string, unknown> }[] } };
type MappingResult = Record<string, { mappings: { properties: Record<string, unknown> } }>;
async function ids(body: unknown): Promise<string[]> {
  const response = await search.request<SearchResult>('POST', `/${index}/_search`, {
    size: 200,
    ...(body as object),
  });
  return response.body.hits.hits.map((hit) => hit._id);
}

test('overflow markers are fixed keyword fields and declared relation values retain statement and qualifier matching', async () => {
  const mapping = await search.request<MappingResult>('GET', `/${index}/_mapping`);
  const properties = mapping.body[index]!.mappings.properties;
  expect(properties.relation_facet_overflow).toEqual({ type: 'keyword' });
  expect(properties[authorProperty]).toBeUndefined();

  expect(await ids({ query: { term: { relation_facet_overflow: authorProperty } } })).toEqual([bookId]);
  expect(await ids({ query: { term: { [`statements`]: `${authorProperty}=${sampledAuthor}` } } })).toEqual([bookId]);

  const nested = (role: string) =>
    ids({
      query: {
        nested: {
          path: 'facts',
          query: {
            bool: {
              filter: [
                { term: { 'facts.property': authorProperty } },
                { term: { 'facts.value': sampledAuthor } },
                { term: { 'facts.qualifiers': `${roleProperty}=${role}` } },
              ],
            },
          },
        },
      },
    });
  expect(await nested(lead)).toEqual([bookId]);
  expect(await nested(support)).toEqual([]);
});

test('relation markers stay on the source subject document and keep external versions', async () => {
  expect(await ids({ query: { term: { relation_facet_overflow: authorProperty } } })).toEqual([bookId]);
  const targetResult = await search.request<{ _version: number; _source: Record<string, unknown> }>(
    'GET',
    `/${index}/_doc/${targetId}`,
  );
  expect(targetResult.body._source.relation_facet_overflow).toBeUndefined();
  expect(targetResult.body._version).toBe(11);

  const original = documentActions({ partition: 10, position: 11n, subjects: [book] }, [bookId]);
  expect(bulkLines(index, original)[0]).toEqual({
    index: { _index: index, _id: bookId, version: 11, version_type: 'external' },
  });
  const staleBook = subject(bookId, [], []);
  const stale = (await search.bulk(
    bulkLines(index, documentActions({ partition: 10, position: 10n, subjects: [staleBook] }, [bookId])),
  )) as { items: { index: { status: number } }[] };
  expect(stale.items[0]!.index.status).toBe(409);
  expect((await search.request<{ _version: number }>('GET', `/${index}/_doc/${bookId}`)).body._version).toBe(11);
});

test('the document keeps all 128 sampled relation values and omits empty overflow markers', async () => {
  const bookResult = await search.request<{ _source: Record<string, unknown> }>('GET', `/${index}/_doc/${bookId}`);
  const source = bookResult.body._source;
  expect(source.statements).toHaveLength(MAX_RELATION_FACET_VALUES);
  expect(source.facts).toHaveLength(MAX_RELATION_FACET_VALUES);
  expect(source.statements).toEqual(authors.map((author) => `${authorProperty}=${author}`));
  expect(
    (source.facts as { property: string; value: string; qualifiers: string[] }[]).map(
      ({ property, value, qualifiers }) => [property, value, qualifiers],
    ),
  ).toEqual(
    authors.map((author, index) => [
      authorProperty,
      author,
      index === 0
        ? [`${roleProperty}=${support}`]
        : index === MAX_RELATION_FACET_VALUES - 1
          ? [`${roleProperty}=${lead}`]
          : [],
    ]),
  );
  expect(source.relation_facet_overflow).toEqual([authorProperty]);
  const targetSource = (await search.request<{ _source: Record<string, unknown> }>('GET', `/${index}/_doc/${targetId}`))
    .body._source;
  expect(targetSource.relation_facet_overflow).toBeUndefined();

  const emptyMarkerSubject = subject(id(5), [], []);
  const emptyMarkerAction = documentActions({ partition: 10, position: 11n, subjects: [emptyMarkerSubject] }, [
    emptyMarkerSubject.id,
  ])[0];
  expect(emptyMarkerAction?.op).toBe('index');
  if (emptyMarkerAction?.op === 'index') expect('relation_facet_overflow' in emptyMarkerAction.document).toBe(false);
});
