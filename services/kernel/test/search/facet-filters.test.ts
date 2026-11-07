import { searchOperationProblem } from '../../src/search/http/operation-problems.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { IndexedStatement, IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;

const id = (partition: string, n: number) => `018f0000-0000-7000-8000-${partition}${String(n).padStart(8, '0')}`;
const [author, other, lead, support] = [id('00b0', 1), id('00b0', 2), id('00b0', 3), id('00b0', 4)];
const item = (
  property: string,
  value: string,
  qualifiers?: { property: string; value: string }[],
): IndexedStatement => ({
  property,
  value,
  facet: { kind: 'item' },
  ...(qualifiers ? { qualifiers } : {}),
});
const year = (value: number): IndexedStatement => ({
  property: 'schema:datePublished',
  value: JSON.stringify({
    time: `${value < 0 ? '-' : '+'}${String(Math.abs(value)).padStart(4, '0')}-01-01T00:00:00Z`,
    precision: 9,
  }),
  facet: { kind: 'time', year: value },
});
const minutes = (amount: number, unit: string): IndexedStatement => ({
  property: 'schema:totalTime',
  value: JSON.stringify({ amount: `+${amount}`, unit }),
  facet: { kind: 'quantity', amount, unit },
});
const subject = (n: number, label: string, type: string, statements: IndexedStatement[]): IndexedSubject => ({
  id: id('00a0', n),
  type,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: label }],
  aliases: [],
  descriptions: [],
  statements,
});
const role = (value: string) => [{ property: 'rezics:role', value }];
const first = subject(1, 'Book one', 'schema:Book', [item('schema:author', author, role(lead)), year(1995)]);
const second = subject(2, 'Book two', 'schema:Book', [
  item('schema:author', author, role(support)),
  item('schema:author', other, role(lead)),
  year(-500),
]);
const old = subject(3, 'Old book', 'schema:Book', [year(1850)]);
const soup = subject(4, 'Soup', 'schema:Recipe', [minutes(45, 'unit:MIN')]);
const stew = subject(5, 'Stew', 'schema:Recipe', [minutes(1.5, 'unit:HUR')]);
const release: FilterRelease = {
  types: {
    'schema:Book': { bases: [], facets: ['schema:author', 'schema:datePublished'] },
    'schema:Recipe': { bases: [], facets: ['schema:totalTime'] },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item', qualifiers: ['rezics:role'] },
    'rezics:role': { datatype: 'wikibase-item' },
    'schema:genre': { datatype: 'wikibase-item' },
    'schema:datePublished': { datatype: 'time' },
    'schema:totalTime': { datatype: 'quantity', units: ['unit:MIN', 'unit:HUR'] },
  },
  filters: {
    'books/early': {
      filter: {
        and: [
          { type: { in: ['schema:Book'] } },
          { statement: { property: 'schema:datePublished', range: { lte: 1900 } } },
        ],
      },
    },
  },
};
const fake = createFakeSource();
const service = createSearchService({ pool, client, prefix, source: fake, cursors, release: async () => release });
const index = subjectIndexName(prefix, 1);

beforeAll(async () => {
  const subjects = [first, second, old, soup, stew];
  for (const entry of subjects) fake.put(entry);
  await createSubjectIndex(client, prefix, 1);
  const snapshot = await fake.read(
    10,
    subjects.map((entry) => entry.id),
  );
  await client.bulk(
    bulkLines(
      index,
      documentActions(
        snapshot,
        snapshot.subjects.map((entry) => entry.id),
      ),
    ),
    {
      query: { refresh: 'wait_for' },
    },
  );
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

const search = (filter: unknown) => service.search('anonymous', { filter, sort: 'name' });
const names = async (filter: unknown) => (await search(filter)).subjects.map((result) => result.labels.en);
async function problem(promise: Promise<unknown>, code: string, errors: { pointer: string; code: string }[]) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => searchOperationProblem(caught),
  );
  expect(error).toBeInstanceOf(ProblemError);
  expect([(error as ProblemError).code, (error as ProblemError).errors] as unknown[]).toEqual([code, errors]);
  return error as ProblemError;
}

test('statement conditions bind qualifiers to one statement', async () => {
  const byAuthor = { property: 'schema:author', in: [author] };
  expect(await names({ statement: byAuthor })).toEqual(['Book one', 'Book two']);
  const leading = [{ property: 'rezics:role', in: [lead] }];
  expect(await names({ statement: { ...byAuthor, qualifiers: leading } })).toEqual(['Book one']);
  expect(await names({ statement: { property: 'schema:author', in: [author, other], qualifiers: leading } })).toEqual([
    'Book one',
    'Book two',
  ]);
  const supporting = { ...byAuthor, qualifiers: [{ property: 'rezics:role', in: [support] }] };
  expect(await names({ and: [{ type: { in: ['schema:Book'] } }, { not: { statement: supporting } }] })).toEqual([
    'Book one',
    'Old book',
  ]);
});

test('ranges filter years and quantities in their units', async () => {
  const published = (range: object) => ({ statement: { property: 'schema:datePublished', range } });
  expect(await names(published({ gte: 1990, lte: 1999 }))).toEqual(['Book one']);
  expect(await names(published({ lte: 1900 }))).toEqual(['Book two', 'Old book']);
  expect(await names(published({ lte: 0 }))).toEqual(['Book two']);
  const time = (range: object) => ({ statement: { property: 'schema:totalTime', range } });
  expect(await names(time({ lte: 60, unit: 'unit:MIN' }))).toEqual(['Soup']);
  expect(await names(time({ gte: 1, lte: 2, unit: 'unit:HUR' }))).toEqual(['Stew']);
  expect(await names(time({ gte: 46, unit: 'unit:MIN' }))).toEqual([]);
});

test('saved filters expand and only registered facets are admitted', async () => {
  expect(await names({ saved: 'books/early' })).toEqual(['Book two', 'Old book']);
  await problem(search({ statement: { property: 'schema:genre', in: [author] } }), 'unsupported_query', [
    { pointer: '/filter/statement/property', code: 'unsupported' },
  ]);
  const recipesByYear = {
    and: [{ type: { in: ['schema:Recipe'] } }, { statement: { property: 'schema:datePublished', range: { lte: 1 } } }],
  };
  await problem(search(recipesByYear), 'unsupported_query', [
    { pointer: '/filter/and/1/statement/property', code: 'unsupported' },
  ]);
  await problem(search({ saved: 'books/missing' }), 'unsupported_query', [
    { pointer: '/filter/saved', code: 'unsupported' },
  ]);
  await problem(search({ statement: { property: 'schema:totalTime', range: { lte: 60 } } }), 'invalid_request', [
    { pointer: '/filter/statement/range/unit', code: 'required' },
  ]);
});

test('the final check rejects a hit whose current statement no longer satisfies its condition', async () => {
  fake.put({ ...first, statements: [item('schema:author', author, role(support)), year(2005)] });
  try {
    expect(await names({ statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } })).toEqual(
      [],
    );
    const leading = { property: 'schema:author', in: [author], qualifiers: [{ property: 'rezics:role', in: [lead] }] };
    expect(await names({ statement: leading })).toEqual([]);
    expect(await names({ statement: { property: 'schema:author', in: [author] } })).toEqual(['Book one', 'Book two']);
  } finally {
    fake.put(first);
  }
});

test('a filter without an active release answers semantic_not_ready', async () => {
  const unready = createSearchService({ pool, client, prefix, source: fake, cursors, release: async () => null });
  const caught = await unready
    .search('anonymous', { filter: { type: { in: ['schema:Book'] } } })
    .catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(ProblemError);
  expect((caught as ProblemError).code).toBe('semantic_not_ready');
  expect((caught as ProblemError).headers).toEqual({ 'retry-after': '1' });
  const text = await unready.search('anonymous', { text: 'Soup' });
  expect(text.subjects.map((result) => result.labels.en)).toEqual(['Soup']);
});
