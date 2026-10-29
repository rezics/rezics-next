import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { decodeSearchCursor } from '../../src/search/cursor.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, searchSubjects } from '../../src/search/query.ts';
import { createSearchService, type SearchRequest } from '../../src/search/service.ts';
import type { IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { testKernel } from '../support/test-kernel.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(71)]]) };
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const author = id(11);
const rejectedAuthor = id(12);
const book = (n: number, name: string, by: string): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: name }],
  aliases: [],
  descriptions: [],
  statements: [
    { property: 'schema:author', value: by, facet: { kind: 'item' } },
    { property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } },
  ],
});
const books = [
  book(1, 'Aggregate alpha', author),
  book(2, 'Aggregate beta', rejectedAuthor),
  book(3, 'Aggregate gamma', author),
];
const people = [author, rejectedAuthor].map((value, i) => ({
  ...book(11 + i, i ? 'Rejected author' : 'Author', author),
  id: value,
  type: 'schema:Person',
  statements: [],
}));
const source = createFakeSource();
const release: FilterRelease & { types: Record<string, { labels: Record<string, string> }> } = {
  types: {
    'schema:Book': { facets: ['schema:author', 'schema:inLanguage'], labels: { en: 'Book' } },
    'schema:Person': { facets: [], labels: { en: 'Person' } },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item' },
    'schema:inLanguage': { datatype: 'string', value: { pattern: '^[a-z]{2}$' } },
  },
};
// Real engine documents and a controllable current source isolate serialization. This is
// not proof of native source authority, complete indexing, or safe facet membership,
// exclusion, NOT or ordering. No preparation or worker readiness is manufactured.
const service = createSearchService({ pool, client, prefix, source, cursors, release: async () => release });
const kernel = testKernel({ pool, search: service });
const asOf = '2025-01-01T00:00:00.000Z';
const booksOnly = { type: { in: ['schema:Book'] } };
const facets = [{ property: 'type' }, { property: 'schema:inLanguage' }, { property: 'schema:author' }];

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  for (const entry of [...books, ...people]) source.put(entry);
  const ids = [...books, ...people].map(({ id }) => id);
  await client.bulk(bulkLines(index, documentActions(await source.read(10, ids), ids)), {
    query: { refresh: 'wait_for' },
  });
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  // An actual unconsumed envelope makes freshness deterministic through the real
  // checkpoint query; this does not certify index readiness or completeness.
  await pool.query(`UPDATE core.partition SET position = position + 1 WHERE partition_no = 700`);
  await pool.query(
    `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
     SELECT partition_no, position, 0, 1, epoch, $1, 'com.rezics.subject.created.v1', $2,
            jsonb_build_object('id', $2::text), $3 FROM core.partition WHERE partition_no = 700`,
    [crypto.randomUUID(), id(1), asOf],
  );
  // Leave indexed candidates intact while current source rejects one hit and one item value.
  source.put({ ...books[1]!, visibility: 'hidden' });
  source.put({ ...people[1]!, visibility: 'hidden' });
});
afterAll(async () => {
  await client.request('DELETE', `/${index}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

function keys(value: object, expected: string[]) {
  // An allowlist also rejects renamed estimates, count-only rankings and private
  // candidate metadata, rather than checking only the former field names.
  expect(Object.keys(value).sort()).toEqual(expected.sort());
}
function searchShape(answer: Awaited<ReturnType<typeof service.search>>) {
  keys(answer, ['subjects', 'next', 'as_of']);
  for (const hit of answer.subjects) keys(hit, ['id', 'type', 'labels']);
}
function facetShape(answer: Awaited<ReturnType<typeof service.facets>>) {
  keys(answer, ['facets', 'as_of']);
  for (const facet of answer.facets) {
    keys(facet, ['property', 'values']);
    for (const value of facet.values) keys(value, ['value', 'labels']);
  }
}
const projectedFacets = [
  { property: 'type', values: [{ value: 'schema:Book', labels: { en: 'Book' } }] },
  { property: 'schema:inLanguage', values: [{ value: 'en', labels: {} }] },
  { property: 'schema:author', values: [{ value: author, labels: { en: 'Author' } }] },
];

for (const [name, request, expected] of [
  ['nonempty with an exact engine count and a rejected candidate', { sort: 'id', limit: 1 }, [id(1)]],
  ['zero hits', { text: 'unfindableterm', sort: 'id' }, []],
  ['restricted filter', { filter: booksOnly, sort: 'id' }, [id(1), id(3)]],
] satisfies [string, SearchRequest, string[]][]) {
  test(`search omits every aggregate: ${name}`, async () => {
    const answer = await service.search('anonymous', request);
    expect(answer.subjects.map(({ id }) => id)).toEqual(expected);
    expect(answer.as_of).toBe(asOf);
    if (request.limit === 1) {
      // Inspect the actual engine response, not a preselected service replacement.
      const engine = await searchSubjects(client, prefix, { sort: 'id', size: 10 });
      expect(engine.total).toEqual({ value: 5, relation: 'exact' });
      expect(engine.hits.map(({ id }) => id)).toContain(id(2));
      expect(answer.next).toEqual(expect.any(String));
      // The ordinary cursor consumes rejected lookahead before the next disclosed hit.
      const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'id', limit: 1 } };
      expect(await decodeSearchCursor(cursors, binding, answer.next!)).toMatchObject({
        ok: true,
        generation: 1,
        after: [id(2)],
      });
      const next = await service.search('anonymous', { ...request, cursor: answer.next! });
      expect(next.subjects.map(({ id }) => id)).toEqual([id(3)]);
      expect(next.as_of).toBe(asOf);
      searchShape(next);
    } else expect(answer.next).toBeNull();
    searchShape(answer);
  });
}

for (const empty of [false, true]) {
  test(`facets omit totals, value counts and relations (${empty ? 'zero hits' : 'type/code/item and rejected item'})`, async () => {
    const answer = await service.facets('anonymous', {
      filter: booksOnly,
      facets,
      ...(empty ? { text: 'unfindableterm' } : {}),
    });
    expect(answer.as_of).toBe(asOf);
    // Compare public content independently so aggregate failures cannot conceal a
    // missing property, label or valid value. No safe-population claim is made.
    expect(
      answer.facets.map(({ property, values }) => ({
        property,
        values: values.map(({ value, labels }) => ({ value, labels })),
      })),
    ).toEqual(empty ? facets.map(({ property }) => ({ property, values: [] })) : projectedFacets);
    facetShape(answer);
  });
}

function request(operation: 'search' | 'facets' | 'suggest', body: unknown = {}, authorization?: string) {
  const headers = { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) };
  return kernel.handle(
    new Request(`http://kernel.test/v1/subjects:${operation}${operation === 'suggest' ? '?q=Aggregate' : ''}`, {
      method: operation === 'suggest' ? 'GET' : 'POST',
      headers,
      ...(operation === 'suggest' ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function aggregateHeaders(response: Response) {
  expect(
    [...response.headers.keys()].filter((name) => /total|count|relation|estimate|content-range/i.test(name)),
  ).toEqual([]);
}
for (const operation of ['search', 'facets', 'suggest'] as const) {
  test(`anonymous HTTP ${operation} uses the actual response schema without aggregate metadata`, async () => {
    const response = await request(
      operation,
      operation === 'facets' ? { filter: booksOnly, facets } : { filter: booksOnly, sort: 'id' },
    );
    expect(response.status).toBe(200);
    aggregateHeaders(response);
    const answer = await response.json();
    expect(answer.as_of).toBe(asOf);
    if (operation === 'facets') {
      expect(answer.facets).toEqual(projectedFacets);
      facetShape(answer);
    } else {
      expect(answer.subjects.map(({ id }: { id: string }) => id).sort()).toEqual([id(1), id(3)]);
      for (const hit of answer.subjects) keys(hit, ['id', 'type', 'labels', 'summary']);
      keys(answer, operation === 'search' ? ['subjects', 'next', 'as_of'] : ['subjects', 'as_of']);
      if (operation === 'search') expect(answer.next).toBeNull();
    }
  });
  test(`HTTP ${operation} preserves invalid bearer rejection instead of anonymous fallback`, async () => {
    const response = await request(
      operation,
      operation === 'facets' ? { filter: booksOnly, facets } : {},
      'Bearer invalid',
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'invalid_credentials' });
  });
}

test('HTTP search preserves typed invalid cursor and unsupported filter errors', async () => {
  const cursor = await request('search', { cursor: 'invalid' });
  expect(cursor.status).toBe(400);
  expect(await cursor.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/cursor', code: 'invalid_format' }],
  });
  const unsupported = await request('search', { filter: { statement: { property: 'schema:unknown', in: [author] } } });
  expect(unsupported.status).toBe(422);
  expect(await unsupported.json()).toMatchObject({ code: 'unsupported_query' });
});

test('suggest keeps only subjects and checkpoint-derived as_of', async () => {
  const answer = await service.suggest('Aggregate');
  expect(answer.subjects.map(({ id }) => id).sort()).toEqual([id(1), id(3)]);
  expect(answer.as_of).toBe(asOf);
  keys(answer, ['subjects', 'as_of']);
  for (const hit of answer.subjects) keys(hit, ['id', 'type', 'labels']);
});
