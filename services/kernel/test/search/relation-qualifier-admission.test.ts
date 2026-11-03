import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
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
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const access: Access = {
  async authenticate() {
    throw new Error('Only anonymous reads are used');
  },
  async authorize() {
    return true;
  },
};
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const [author, other, lead, support] = [id(101), id(102), id(103), id(104)];
const relationProperty = 'schema:author';
const descriptiveProperty = 'schema:genre';
const role = 'rezics:role';
const release: FilterRelease = {
  types: { 'schema:Book': { facets: [relationProperty, descriptiveProperty] } },
  properties: {
    [relationProperty]: { datatype: 'wikibase-item', qualifiers: [role], relation: { group: 'credit' } },
    [descriptiveProperty]: { datatype: 'wikibase-item', qualifiers: [role], relation: { group: 'classification' } },
    [role]: { datatype: 'wikibase-item' },
  },
};
const statement = (property: string, value: string, qualifier?: string): IndexedStatement => ({
  property,
  value,
  facet: { kind: 'item' },
  ...(qualifier ? { qualifiers: [{ property: role, value: qualifier }] } : {}),
});
const subject = (n: number, statements: IndexedStatement[]): IndexedSubject => ({
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
const subjects = [
  subject(1, [statement(relationProperty, author, lead), statement(descriptiveProperty, author, lead)]),
  subject(2, [
    statement(relationProperty, author, support),
    statement(descriptiveProperty, author, support),
    statement(descriptiveProperty, other, lead),
  ]),
  subject(3, [statement(descriptiveProperty, other, lead)]),
  subject(4, [statement(descriptiveProperty, author)]),
];
const source = createFakeSource();
let engineRequests = 0;
const counting: OpenSearch = {
  request: ((...args: Parameters<OpenSearch['request']>) => {
    engineRequests++;
    return client.request(...args);
  }) as OpenSearch['request'],
  bulk: ((...args: Parameters<OpenSearch['bulk']>) => {
    engineRequests++;
    return client.bulk(...args);
  }) as OpenSearch['bulk'],
};
const search = createSearchService({
  pool,
  client: counting,
  prefix,
  source,
  cursors: tokens,
  release: async () => release,
});
const kernel = createKernel({ pool, access, tokens, routeKey: new Uint8Array(32).fill(13), search });

beforeAll(async () => {
  for (const entry of subjects) source.put(entry);
  await createSubjectIndex(client, prefix, 1);
  await client.bulk(
    bulkLines(
      index,
      documentActions(
        { partition: 10, position: 1n, subjects },
        subjects.map((s) => s.id),
      ),
    ),
    {
      query: { refresh: 'wait_for' },
    },
  );
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  await client.request('DELETE', `/${index}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

async function call(filter: unknown, method = 'search') {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/subjects:${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filter,
        ...(method === 'facets' ? { facets: [{ property: descriptiveProperty }] } : { sort: 'id' }),
      }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

test('undeclared relation qualifiers are unsupported without reaching the engine', async () => {
  for (const method of ['search', 'facets']) {
    for (const qualifier of ['rezics:episode', 'schema:unknown']) {
      engineRequests = 0;
      const result = await call(
        { statement: { property: relationProperty, in: [author], qualifiers: [{ property: qualifier, in: [lead] }] } },
        method,
      );
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        code: 'unsupported_query',
        effect_status: 'not_applicable',
        errors: [{ pointer: '/filter/statement/qualifiers/0/property', code: 'unsupported' }],
      });
      expect(engineRequests).toBe(0);
    }
  }
});

test('unqualified relation facets and descriptive qualifiers retain their semantics', async () => {
  const ids = async (filter: unknown) => {
    const result = await call(filter);
    expect(result.status).toBe(200);
    return (result.body.subjects as { id: string }[]).map((entry) => entry.id);
  };
  expect(await ids({ statement: { property: relationProperty, in: [author] } })).toEqual([id(1), id(2)]);
  expect(
    await ids({
      statement: { property: relationProperty, in: [author], qualifiers: [{ property: role, in: [lead] }] },
    }),
  ).toEqual([id(1)]);
  const descriptive = { property: descriptiveProperty, in: [author] };
  expect(await ids({ statement: descriptive })).toEqual([id(1), id(2), id(4)]);
  const qualified = { ...descriptive, qualifiers: [{ property: role, in: [lead] }] };
  expect(await ids({ statement: qualified })).toEqual([id(1)]);
  expect(await ids({ statement: { ...qualified, in: [other] } })).toEqual([id(2), id(3)]);
  expect(await ids({ statement: { ...qualified, qualifiers: [{ property: role, in: [support] }] } })).toEqual([id(2)]);
  expect(await ids({ and: [{ type: { in: ['schema:Book'] } }, { not: { statement: qualified } }] })).toEqual([
    id(2),
    id(3),
    id(4),
  ]);
  const invalid = await call({
    statement: { ...descriptive, qualifiers: [{ property: 'schema:unknown', in: [lead] }] },
  });
  expect(invalid.status).toBe(422);
  expect(invalid.body).toMatchObject({
    code: 'unsupported_query',
    errors: [{ pointer: '/filter/statement/qualifiers/0/property', code: 'unsupported' }],
  });
});
