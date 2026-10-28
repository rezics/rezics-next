import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedStatement, type IndexedSubject } from '../../src/search/source.ts';
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
const subject = (
  id: string,
  label: string,
  type: string,
  statements: IndexedStatement[],
  patch: Partial<IndexedSubject> = {},
): IndexedSubject => ({
  id,
  type,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: label }],
  aliases: [],
  descriptions: [],
  statements,
  ...patch,
});
const by = (value: string, role?: string): IndexedStatement => ({
  property: 'schema:author',
  value,
  facet: { kind: 'item' },
  ...(role ? { qualifiers: [{ property: 'rezics:role', value: role }] } : {}),
});
const [a, b, c] = [id('00b0', 1), id('00c0', 2), id('00b0', 3)];
const [lead, support] = [id('00d0', 1), id('00d0', 2)];
const people = [
  subject(a, 'Author A', 'schema:Person', []),
  subject(b, 'Author B', 'schema:Person', []),
  subject(c, 'Author C', 'schema:Person', [], { visibility: 'hidden' }),
];
const books = [
  subject(id('00a0', 1), 'Book one', 'schema:Book', [by(a)]),
  subject(id('00a0', 2), 'Book two', 'schema:Book', [by(a, lead), by(a, support), by(b)]),
  subject(id('00a0', 3), 'Book three', 'schema:Book', [by(a), by(c)]),
  subject(id('00a0', 4), 'Book four', 'schema:Book', [by(b)]),
];
const release = {
  types: {
    'schema:Book': {
      bases: [],
      facets: ['schema:author', 'schema:datePublished'],
      labels: { en: 'Book', 'zh-Hant': '書籍', 'zh-Hans': '书籍' },
    },
    'schema:Person': { bases: [], facets: [], labels: { en: 'Person', fr: 'Personne', 'zh-Hans': '人物' } },
    'schema:Movie': { bases: [], facets: [], labels: { en: 'Movie', 'zh-Hans': '电影' } },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item', qualifiers: ['rezics:role'] },
    'rezics:role': { datatype: 'wikibase-item' },
    'schema:genre': { datatype: 'wikibase-item' },
    'schema:datePublished': { datatype: 'time' },
  },
};
const movies = [subject(id('00e0', 1), 'Movie one', 'schema:Movie', [])];
const unknown = subject(id('00f0', 1), 'Unknown one', 'schema:Unknown', []);
const entries = [...books, ...people, ...movies, unknown];
const fake = createFakeSource();
let reads = 0;
const source = {
  ...fake,
  read(...args: Parameters<typeof fake.read>) {
    reads++;
    return fake.read(...args);
  },
};
const options = { pool, client, prefix, source, cursors, release: async () => release };
const service = createSearchService(options);
const index = subjectIndexName(prefix, 1);

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  const byPartition = new Map<number, IndexedSubject[]>();
  for (const entry of entries) fake.put(entry);
  for (const entry of entries) {
    const partition = subjectPartition(entry.id);
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), entry]);
  }
  for (const [partition, entries] of byPartition) {
    const ids = entries.map((entry) => entry.id);
    const snapshot = await fake.read(partition, ids);
    await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

const kernel = createKernel({
  pool,
  routeKey: new Uint8Array(32).fill(13),
  search: service,
  access: {
    async authenticate() {
      throw new Error('no credentials in this test');
    },
    async authorize() {
      return true;
    },
  },
});
const types = (size?: number) => [{ property: 'type', ...(size === undefined ? {} : { size }) }];
const expected = (value: keyof typeof release.types) => ({
  value,
  labels: release.types[value].labels,
});
const request = (body: unknown) =>
  kernel.handle(
    new Request('http://kernel.test/v1/subjects:facets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

test('a type facet returns ordered types with release labels and no public counts', async () => {
  const before = reads;
  const response = await request({ facets: types() });
  expect(response.status).toBe(200);
  const answer = await response.json();
  expect(answer).not.toHaveProperty('total');
  expect(answer.facets).toEqual([
    {
      property: 'type',
      values: [expected('schema:Book'), expected('schema:Person'), expected('schema:Movie')],
    },
  ]);
  expect(answer.facets[0]).not.toHaveProperty('relation');
  for (const value of answer.facets[0].values) expect(value).not.toHaveProperty('count');
  expect(answer.as_of).toEqual(expect.any(String));
  expect(reads).toBe(before);
  const limited = await service.facets('anonymous', { facets: types(1) });
  expect(limited.facets[0]!.values).toEqual([expected('schema:Book')]);
  // Unknown types are dropped before cutting the result to size; ties use the type CURIE.
  const tied = await service.facets('anonymous', { text: 'one', facets: types(2) });
  expect(tied.facets[0]!.values).toEqual([expected('schema:Book'), expected('schema:Movie')]);
  const sampled = createSearchService({ ...options, facetSample: 2 });
  const lower = await sampled.facets('anonymous', { facets: types() });
  expect(lower).not.toHaveProperty('total');
  expect(lower.facets[0]).not.toHaveProperty('relation');
  const sampledValues = lower.facets[0]!.values;
  expect(sampledValues.length).toBeLessThanOrEqual(2);
  expect(new Set(sampledValues.map(({ value }) => value)).size).toBe(sampledValues.length);
  for (const value of sampledValues) {
    expect(['schema:Book', 'schema:Person', 'schema:Movie']).toContain(value.value);
    expect(value).not.toHaveProperty('count');
  }
  expect(reads).toBe(before);
  const operation = openApiDocument(kernel).paths['/v1/subjects:facets']!.post!;
  expect(JSON.stringify(operation.responses)).not.toContain('"format":"uuid"');
});

test("type facet labels follow the reader's language chain", async () => {
  const chinese = await service.facets('anonymous', {
    facets: types(),
    languages: ['zh-Hans', 'zh', 'zh-Hant'],
  });
  expect(chinese.facets[0]!.values.map(({ value, labels }) => ({ value, labels }))).toEqual([
    { value: 'schema:Book', labels: { 'zh-Hans': '书籍' } },
    { value: 'schema:Person', labels: { 'zh-Hans': '人物' } },
    { value: 'schema:Movie', labels: { 'zh-Hans': '电影' } },
  ]);

  const english = await service.facets('anonymous', { facets: types(), languages: ['en'] });
  expect(english.facets[0]!.values.map(({ value, labels }) => ({ value, labels }))).toEqual([
    { value: 'schema:Book', labels: { en: 'Book' } },
    { value: 'schema:Person', labels: { en: 'Person' } },
    { value: 'schema:Movie', labels: { en: 'Movie' } },
  ]);

  const all = await service.facets('anonymous', { facets: types() });
  expect(all.facets[0]!.values).toEqual([expected('schema:Book'), expected('schema:Person'), expected('schema:Movie')]);
});

test('a type facet returns values within the text and filter, including a type filter', async () => {
  const text = await service.facets('anonymous', { text: 'one', facets: types() });
  expect(text.facets[0]!.values).toEqual([expected('schema:Book'), expected('schema:Movie')]);
  const filter = { type: { in: ['schema:Book', 'schema:Person'] } };
  const filtered = await service.facets('anonymous', { filter, facets: types() });
  expect(filtered.facets[0]!.values).toEqual([expected('schema:Book'), expected('schema:Person')]);
  const both = await service.facets('anonymous', { text: 'one', filter, facets: types() });
  expect(both.facets[0]!.values).toEqual([expected('schema:Book')]);
  const statement = await service.facets('anonymous', {
    filter: { statement: { property: 'schema:author', in: [a] } },
    facets: types(),
  });
  expect(statement.facets[0]!.values).toEqual([expected('schema:Book')]);
  const empty = await service.facets('anonymous', {
    filter: { and: [{ type: { in: ['schema:Book'] } }, { type: { in: ['schema:Person'] } }] },
    facets: types(),
  });
  expect(empty.facets[0]!.values).toEqual([]);
});

test('a type facet is requested at most once and keeps the facet size bounds', async () => {
  for (const [facets, pointer, code] of [
    [[...types(), ...types()], '/facets/1/property', 'invalid_format'],
    [types(0), '/facets/0/size', 'out_of_range'],
    [types(21), '/facets/0/size', 'out_of_range'],
  ] as const) {
    const response = await request({ facets });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request', errors: [{ pointer, code }] });
  }
  const mixed = await request({
    filter: { type: { in: ['schema:Book'] } },
    facets: [...types(20), { property: 'schema:author' }],
  });
  expect(mixed.status).toBe(200);
  expect((await mixed.json()).facets).toEqual([
    { property: 'type', values: [expected('schema:Book')] },
    {
      property: 'schema:author',
      values: [
        { value: a, labels: { en: 'Author A' } },
        { value: b, labels: { en: 'Author B' } },
      ],
    },
  ]);
});
