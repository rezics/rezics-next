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
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(6)]]) };
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const language = (value: string): IndexedStatement => ({
  property: 'schema:inLanguage',
  value,
  facet: { kind: 'code' },
});
const book = (n: number, label: string, statements: IndexedStatement[]): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: label }],
  aliases: [],
  descriptions: [],
  statements,
});
const books = [
  book(1, 'Book one', [language('ja')]),
  book(2, 'Book two', [language('ja'), language('en')]),
  book(3, 'Book three', [language('zh-Hant'), { property: 'schema:alternateName', value: 'ja' }]),
];
const release: FilterRelease = {
  types: { 'schema:Book': { bases: [], facets: ['schema:inLanguage', 'schema:alternateName'] } },
  properties: {
    'schema:inLanguage': { datatype: 'string', value: { pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' } },
    'schema:alternateName': { datatype: 'string' },
  },
};
const fake = createFakeSource();
let reads = 0;
const source = {
  ...fake,
  read(...args: Parameters<typeof fake.read>) {
    reads++;
    return fake.read(...args);
  },
};
const service = createSearchService({ pool, client, prefix, source, cursors, release: async () => release });
const index = subjectIndexName(prefix, 1);

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  for (const entry of books) fake.put(entry);
  const ids = books.map((entry) => entry.id);
  const snapshot = await fake.read(10, ids);
  await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

const names = async (values: string[]) =>
  (
    await service.search('anonymous', {
      filter: { statement: { property: 'schema:inLanguage', in: values } },
      sort: 'name',
    })
  ).subjects.map((result) => result.labels.en);
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return [(error as ProblemError).code, (error as ProblemError).errors] as unknown[];
}

test('code facets filter by exact value', async () => {
  expect(await names(['ja'])).toEqual(['Book one', 'Book two']);
  expect(await names(['zh-Hant'])).toEqual(['Book three']);
  expect(await names(['en', 'zh-Hant'])).toEqual(['Book three', 'Book two']);
  expect(await names(['zh-hant'])).toEqual([]);
});

test("code values are checked against the property's pattern", async () => {
  const search = (property: string, values: unknown[]) =>
    service.search('anonymous', { filter: { statement: { property, in: values } } });
  expect(await refusal(search('schema:inLanguage', ['ja', 'JA']))).toEqual([
    'invalid_request',
    [{ pointer: '/filter/statement/in/1', code: 'invalid_format' }],
  ]);
  const long = ['ab', ...Array.from({ length: 15 }, () => 'abcdefgh')].join('-');
  expect(long.length).toBeGreaterThan(128);
  expect(await refusal(search('schema:inLanguage', [long]))).toEqual([
    'invalid_request',
    [{ pointer: '/filter/statement/in/0', code: 'invalid_format' }],
  ]);
  expect(await refusal(search('schema:alternateName', ['ja']))).toEqual([
    'unsupported_query',
    [{ pointer: '/filter/statement/in', code: 'unsupported' }],
  ]);
});

test('code facets return ordered values without subjects or public counts', async () => {
  const before = reads;
  const answer = await service.facets('anonymous', { facets: [{ property: 'schema:inLanguage' }] });
  expect(answer.facets).toEqual([
    {
      property: 'schema:inLanguage',
      values: [
        { value: 'ja', labels: {} },
        { value: 'en', labels: {} },
        { value: 'zh-Hant', labels: {} },
      ],
    },
  ]);
  expect(answer).not.toHaveProperty('total');
  expect(answer.facets[0]).not.toHaveProperty('relation');
  for (const value of answer.facets[0]!.values) expect(value).not.toHaveProperty('count');
  expect(reads).toBe(before);
  expect(await refusal(service.facets('anonymous', { facets: [{ property: 'schema:alternateName' }] }))).toEqual([
    'unsupported_query',
    [{ pointer: '/facets/0/property', code: 'unsupported' }],
  ]);
});

test('the final check drops a stale code match', async () => {
  const first = books[0]!;
  fake.put({ ...first, statements: [language('en')] });
  try {
    expect(await names(['ja'])).toEqual(['Book two']);
  } finally {
    fake.put(first);
  }
});
