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

const id = (n: number) => `018f0000-0000-7000-8000-0070${String(n).padStart(8, '0')}`;
const [author, lead, support, fantasy] = [id(90), id(91), id(92), id(93)];
const subject = (n: number, statements: IndexedSubject['statements']): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements,
});
const first = subject(1, [
  {
    property: 'schema:author',
    value: author,
    facet: { kind: 'item' },
    qualifiers: [
      { property: 'rezics:role', value: lead },
      { property: 'rezics:role', value: lead },
    ],
  },
  { property: 'schema:genre', value: fantasy, facet: { kind: 'item' } },
  { property: 'schema:genre', value: fantasy, facet: { kind: 'item' } },
  {
    property: 'schema:datePublished',
    value: '{"time":"+1995-03-01T00:00:00Z","precision":11}',
    facet: { kind: 'time', year: 1995 },
  },
  {
    property: 'schema:totalTime',
    value: '{"amount":"+45","unit":"unit:MIN"}',
    facet: { kind: 'quantity', amount: 45, unit: 'unit:MIN' },
  },
  { property: 'schema:name', value: 'Stored name' },
]);
const second = subject(2, [
  {
    property: 'schema:author',
    value: author,
    facet: { kind: 'item' },
    qualifiers: [{ property: 'rezics:role', value: support }],
  },
  {
    property: 'schema:author',
    value: id(94),
    facet: { kind: 'item' },
    qualifiers: [{ property: 'rezics:role', value: lead }],
  },
  {
    property: 'schema:datePublished',
    value: '{"time":"-0500-01-01T00:00:00Z","precision":9}',
    facet: { kind: 'time', year: -500 },
  },
  {
    property: 'schema:totalTime',
    value: '{"amount":"+1.5","unit":"unit:HUR"}',
    facet: { kind: 'quantity', amount: 1.5, unit: 'unit:HUR' },
  },
]);
const actions = documentActions({ partition: 7, position: 5n, subjects: [first, second] }, [first.id, second.id]);

beforeAll(async () => {
  await createSubjectIndex(search, prefix, 1);
  await search.bulk(bulkLines(index, actions), { query: { refresh: 'wait_for' } });
});
afterAll(async () => {
  await search.request('DELETE', `/${index}`).catch(() => undefined);
});

type Hits = { hits: { hits: { _id: string }[] } };
async function matching(...conditions: unknown[]): Promise<string[]> {
  const response = await search.request<Hits>('POST', `/${index}/_search`, {
    query: { nested: { path: 'facts', query: { bool: { filter: conditions } } } },
    sort: [{ id: 'asc' }],
  });
  return response.body.hits.hits.map((hit) => hit._id);
}
const term = (field: string, value: string | number) => ({ term: { [`facts.${field}`]: value } });
const range = (field: string, bounds: object) => ({ range: { [`facts.${field}`]: bounds } });

test('a subject document carries one fact per facet-capable statement', () => {
  expect(actions[0]).toMatchObject({ op: 'index', id: first.id });
  const document = (actions[0] as Extract<(typeof actions)[number], { op: 'index' }>).document;
  expect(document.facts).toEqual([
    { property: 'schema:author', value: author, qualifiers: [`rezics:role=${lead}`] },
    { property: 'schema:genre', value: fantasy, qualifiers: [] },
    { property: 'schema:datePublished', year: 1995, qualifiers: [] },
    { property: 'schema:totalTime', amount: 45, unit: 'unit:MIN', qualifiers: [] },
  ]);
  expect(document.statements).toContain('schema:name=Stored name');
  expect(document.statements).toContain(`schema:author=${author}`);
});

test('facts answer qualifier conditions bound to one statement', async () => {
  const byAuthor = [term('property', 'schema:author'), term('value', author)];
  expect(await matching(...byAuthor)).toEqual([first.id, second.id]);
  expect(await matching(...byAuthor, term('qualifiers', `rezics:role=${lead}`))).toEqual([first.id]);
  expect(await matching(...byAuthor, term('qualifiers', `rezics:role=${support}`))).toEqual([second.id]);
  expect(await matching(term('property', 'schema:author'), term('qualifiers', `rezics:role=${lead}`))).toEqual([
    first.id,
    second.id,
  ]);
});

test('facts.value keeps a code of 128 code units', async () => {
  const code = 'a'.repeat(128);
  const entry = subject(3, [{ property: 'schema:inLanguage', value: code, facet: { kind: 'code' } }]);
  const built = documentActions({ partition: 7, position: 6n, subjects: [entry] }, [entry.id]);
  const document = (built[0] as Extract<(typeof built)[number], { op: 'index' }>).document;
  expect(document.facts).toEqual([{ property: 'schema:inLanguage', value: code, qualifiers: [] }]);
  expect(document.statements).toContain(`schema:inLanguage=${code}`);
  await search.bulk(bulkLines(index, built), { query: { refresh: 'wait_for' } });
  expect(await matching(term('property', 'schema:inLanguage'), term('value', code))).toEqual([entry.id]);
});

test('facts answer year and quantity ranges', async () => {
  const published = term('property', 'schema:datePublished');
  expect(await matching(published, range('year', { gte: 1990, lte: 1999 }))).toEqual([first.id]);
  expect(await matching(published, range('year', { lte: 0 }))).toEqual([second.id]);
  const time = term('property', 'schema:totalTime');
  expect(await matching(time, term('unit', 'unit:MIN'), range('amount', { lte: 60 }))).toEqual([first.id]);
  expect(await matching(time, term('unit', 'unit:HUR'), range('amount', { gte: 1, lte: 2 }))).toEqual([second.id]);
  expect(await matching(time, term('unit', 'unit:HUR'), range('amount', { gt: 1.5 }))).toEqual([]);
});
