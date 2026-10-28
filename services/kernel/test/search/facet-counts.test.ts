import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
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
const release: FilterRelease = {
  types: {
    'schema:Book': { bases: [], facets: ['schema:author', 'schema:datePublished'] },
    'schema:Person': { bases: [], facets: [] },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item', qualifiers: ['rezics:role'] },
    'rezics:role': { datatype: 'wikibase-item' },
    'schema:genre': { datatype: 'wikibase-item' },
    'schema:datePublished': { datatype: 'time' },
  },
};
const fake = createFakeSource();
const options = { pool, client, prefix, source: fake, cursors, release: async () => release };
const service = createSearchService(options);
const index = subjectIndexName(prefix, 1);

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  const byPartition = new Map<number, IndexedSubject[]>();
  for (const entry of [...books, ...people]) fake.put(entry);
  for (const entry of [...books, ...people]) {
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
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

const booksOnly = { type: { in: ['schema:Book'] } };
const authors = (size?: number) => [{ property: 'schema:author', ...(size === undefined ? {} : { size }) }];
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return [(error as ProblemError).code, (error as ProblemError).errors] as unknown[];
}

test('facet values retain top k order and labels without public counts', async () => {
  const answer = await service.facets('anonymous', { filter: booksOnly, facets: authors(1) });
  expect(answer).not.toHaveProperty('total');
  expect(answer.facets).toEqual([{ property: 'schema:author', values: [{ value: a, labels: { en: 'Author A' } }] }]);
  expect(answer.facets[0]).not.toHaveProperty('relation');
  for (const value of answer.facets[0]!.values) expect(value).not.toHaveProperty('count');
  expect(answer.as_of).toEqual(expect.any(String));
  const lead2 = await service.facets('anonymous', {
    filter: {
      statement: { property: 'schema:author', in: [a], qualifiers: [{ property: 'rezics:role', in: [lead] }] },
    },
    facets: authors(),
  });
  expect(lead2.facets[0]!.values.map(({ value }) => value)).toEqual([a, b]);
});

test("facet value labels follow the reader's language chain", async () => {
  fake.put({
    ...people[0]!,
    labels: [
      { language: 'zh-Hant', value: '作者甲' },
      { language: 'en', value: 'Author A' },
    ],
  });
  try {
    const chinese = await service.facets('anonymous', {
      filter: booksOnly,
      facets: authors(),
      languages: ['zh-Hans', 'zh', 'zh-Hant', 'en'],
    });
    expect(chinese.facets[0]!.values.find(({ value }) => value === a)!.labels).toEqual({ 'zh-Hant': '作者甲' });

    const english = await service.facets('anonymous', {
      filter: booksOnly,
      facets: authors(),
      languages: ['en'],
    });
    expect(english.facets[0]!.values.find(({ value }) => value === a)!.labels).toEqual({ en: 'Author A' });

    const all = await service.facets('anonymous', { filter: booksOnly, facets: authors() });
    expect(all.facets[0]!.values.find(({ value }) => value === a)!.labels).toEqual({
      'zh-Hant': '作者甲',
      en: 'Author A',
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
    const invalid = await kernel.handle(
      new Request('http://kernel.test/v1/subjects:facets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: booksOnly, facets: authors(), languages: ['en', 'en'] }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: 'invalid_request',
      errors: [{ pointer: '/languages/1', code: 'invalid_format' }],
    });
  } finally {
    fake.put(people[0]!);
  }
});

test('values whose own subject cannot be disclosed are dropped', async () => {
  const answer = await service.facets('anonymous', { filter: booksOnly, facets: authors(10) });
  expect(answer.facets[0]!.values.map(({ value }) => value)).toEqual([a, b]);
  fake.put({ ...people[1]!, redirect: a });
  try {
    const redirected = await service.facets('anonymous', { filter: booksOnly, facets: authors(10) });
    expect(redirected.facets[0]!.values.map(({ value }) => value)).toEqual([a]);
  } finally {
    fake.put(people[1]!);
  }
});

test('facet requests are admitted like filters', async () => {
  expect(await refusal(service.facets('anonymous', { facets: [{ property: 'schema:genre' }] }))).toEqual([
    'unsupported_query',
    [{ pointer: '/facets/0/property', code: 'unsupported' }],
  ]);
  expect(await refusal(service.facets('anonymous', { facets: [{ property: 'schema:datePublished' }] }))).toEqual([
    'unsupported_query',
    [{ pointer: '/facets/0/property', code: 'unsupported' }],
  ]);
  const persons = { type: { in: ['schema:Person'] } };
  expect(await refusal(service.facets('anonymous', { filter: persons, facets: authors() }))).toEqual([
    'unsupported_query',
    [{ pointer: '/facets/0/property', code: 'unsupported' }],
  ]);
  expect(await refusal(service.facets('anonymous', { facets: authors(21) }))).toEqual([
    'invalid_request',
    [{ pointer: '/facets/0/size', code: 'out_of_range' }],
  ]);
  expect(await refusal(service.facets('anonymous', { facets: [] }))).toEqual([
    'invalid_request',
    [{ pointer: '/facets', code: 'out_of_range' }],
  ]);
  const nine = Array.from({ length: 9 }, () => ({ property: 'schema:author' }));
  expect(await refusal(service.facets('anonymous', { facets: nine }))).toEqual([
    'invalid_request',
    [{ pointer: '/facets', code: 'out_of_range' }],
  ]);
  expect(await refusal(service.facets('anonymous', { facets: [...authors(), ...authors()] }))).toEqual([
    'invalid_request',
    [{ pointer: '/facets/1/property', code: 'invalid_format' }],
  ]);
  const unready = createSearchService({ ...options, release: async () => null });
  expect((await refusal(unready.facets('anonymous', { facets: authors() })))[0]).toBe('semantic_not_ready');
});

test('sampled facets return bounded values without public counts', async () => {
  const sampled = createSearchService({ ...options, facetSample: 2 });
  const answer = await sampled.facets('anonymous', { filter: booksOnly, facets: authors(10) });
  expect(answer).not.toHaveProperty('total');
  expect(answer.facets[0]).not.toHaveProperty('relation');
  const values = answer.facets[0]!.values;
  for (const entry of values) {
    expect([a, b]).toContain(entry.value);
    expect(entry).not.toHaveProperty('count');
  }
  expect(new Set(values.map(({ value }) => value)).size).toBe(values.length);
  expect(values.length).toBeLessThanOrEqual(2);
});

test('the facets route serves anonymous readers and is documented', async () => {
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
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects:facets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: booksOnly, facets: authors(1) }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { facets: unknown[] };
  expect(body).not.toHaveProperty('total');
  expect(body.facets[0]).not.toHaveProperty('relation');
  expect(body.facets[0]).not.toHaveProperty('values.0.count');
  expect(body.facets).toEqual([{ property: 'schema:author', values: [{ value: a, labels: { en: 'Author A' } }] }]);
  const operation = openApiDocument(kernel).paths['/v1/subjects:facets']!.post!;
  expect(operation).toMatchObject({
    operationId: 'subject.facets',
    'x-action': 'subject:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(Object.keys(operation.responses!).sort()).toEqual(['200', '400', '401', '403', '422', '503']);
});
