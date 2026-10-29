import { afterAll, expect, test } from 'bun:test';
import type { FilterDocument, FilterQualifier } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import {
  MAX_RELATION_FACET_PROBES,
  MAX_RELATION_FACET_VALUES,
  subjectPartition,
  type IndexedStatement,
  type IndexedSubject,
  type RelationFacetProbe,
  type SubjectSource,
} from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const engine = createOpenSearch(searchUrl);
const prefixes: string[] = [];
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = 'schema:author';
const target = id(9000, '00b0');
const role = { property: 'schema:role', in: [id(9001, '00b0')] };
const language = { property: 'schema:language', in: [id(9002, '00b0')] };
const by = (value: string, qualifiers?: IndexedStatement['qualifiers']): IndexedStatement => ({
  property: author,
  value,
  facet: { kind: 'item' },
  ...(qualifiers ? { qualifiers } : {}),
});
const book = (n: number, statements: IndexedStatement[], patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [{ language: 'en', value: 'Current description' }],
  statements,
  ...patch,
});
const filler = (degree = 128) => Array.from({ length: degree }, (_, n) => by(id(n + 10000, '00b0')));
const value = (qualifiers?: readonly FilterQualifier[]): FilterDocument => ({
  statement: { property: author, in: [target], ...(qualifiers ? { qualifiers } : {}) },
});
const booksOnly: FilterDocument = { type: { in: ['schema:Book'] } };
const release = {
  types: {
    'schema:Book': { facets: [author], labels: { en: 'Book' } },
    'schema:Recipe': { facets: [author], labels: { en: 'Recipe' } },
    'schema:Person': { facets: [], labels: { en: 'Person' } },
  },
  properties: {
    [author]: {
      datatype: 'wikibase-item',
      qualifiers: [role.property, language.property],
      relation: { group: 'credit' },
    },
    [role.property]: { datatype: 'wikibase-item' },
    [language.property]: { datatype: 'wikibase-item' },
  },
  filters: { 'books/by-target': { filter: { and: [booksOnly, value()] } } },
};

afterAll(async () => {
  for (const prefix of prefixes) {
    for (const generation of [1, 2])
      await engine.request('DELETE', `/${subjectIndexName(prefix, generation)}`).catch(() => undefined);
    for (const name of [SEARCH_TEMPLATE, FACET_TEMPLATE, SUGGEST_TEMPLATE])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
  await pool.end();
});

type EngineCall = {
  id: string;
  params: { size: number; after?: string[]; overflow_properties?: string[]; has_overflow: boolean };
};
async function deployment(entries: IndexedSubject[]) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const fake = createFakeSource();
  for (const entry of entries) fake.put(entry);
  fake.put(book(9000, [], { id: target, type: 'schema:Person', labels: [{ language: 'en', value: 'Target' }] }));
  const reads: { partition: number; ids: readonly string[] }[] = [];
  const probes: { partition: number; probes: readonly RelationFacetProbe[] }[] = [];
  const calls: EngineCall[] = [];
  const lineage: string[][] = [];
  let failProbe = false;
  let allowed = true;
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push({ partition, ids: [...ids] });
      const snapshot = await fake.read(partition, ids);
      return {
        ...snapshot,
        subjects: snapshot.subjects.map((subject) => {
          const relations = subject.statements.filter((s) => s.property === author);
          return {
            ...subject,
            statements: [
              ...subject.statements.filter((s) => s.property !== author),
              ...relations.slice(0, MAX_RELATION_FACET_VALUES),
            ],
            relationFacetOverflow: relations.length > MAX_RELATION_FACET_VALUES ? [author] : [],
          };
        }),
      };
    },
    async count() {
      throw new Error('Search must not scan or count the source');
    },
    async matchRelationFacets(partition, points) {
      expect(points.length).toBeLessThanOrEqual(MAX_RELATION_FACET_PROBES);
      expect(points.every((point) => subjectPartition(point.subject) === partition)).toBe(true);
      probes.push({ partition, probes: structuredClone(points) });
      if (failProbe) throw new Error('Point lookup unavailable');
      return fake.matchRelationFacets(partition, points);
    },
  };
  const client: OpenSearch = {
    ...engine,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[1].endsWith('/_search/template')) calls.push(args[2] as EngineCall);
      const response = await engine.request<T>(...args);
      if (args[1].endsWith('/_search/template')) {
        const body = response.body as { hits: { hits: { matched_queries?: string[] }[] } };
        lineage.push(...body.hits.hits.map((hit) => hit.matched_queries ?? []));
      }
      return response;
    },
  };
  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(engine, prefix, 1);
  const groups = new Map<number, string[]>();
  for (const entry of entries) {
    const partition = subjectPartition(entry.id);
    groups.set(partition, [...(groups.get(partition) ?? []), entry.id]);
  }
  for (const [partition, ids] of groups) {
    const snapshot = await source.read(partition, ids);
    const result = await engine.bulk<{ errors: boolean }>(bulkLines(index, documentActions(snapshot, ids)), {
      query: { refresh: 'wait_for' },
    });
    expect(result.errors).toBe(false);
  }
  await engine.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  const service = createSearchService({ pool, client, prefix, source, cursors, release: async () => release });
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(13),
    search: service,
    access: {
      async authenticate() {
        throw new Error('No credentials in this test');
      },
      async authorize(_client, _actor, action) {
        return allowed && action === 'subject:read';
      },
    },
  });
  const reset = () => {
    reads.length = 0;
    probes.length = 0;
    calls.length = 0;
    lineage.length = 0;
  };
  async function request(operation: 'search' | 'facets', body: unknown, resetBeforeRequest = true) {
    if (resetBeforeRequest) reset();
    return kernel.handle(
      new Request(`http://kernel.test/v1/subjects:${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }
  async function search(filter: FilterDocument, options: Record<string, unknown> = {}) {
    const response = await request('search', { filter, sort: 'id', ...options });
    const body = await response.json();
    expect(response.status, JSON.stringify({ filter, body })).toBe(200);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.every((call) => call.params.size <= 200)).toBe(true);
    return body;
  }
  return {
    prefix,
    index,
    fake,
    source,
    reads,
    probes,
    calls,
    lineage,
    search,
    request,
    reset,
    fail: (value: boolean) => {
      failProbe = value;
    },
    allow: (value: boolean) => {
      allowed = value;
    },
  };
}
const ids = (page: { subjects: { id: string }[] }) => page.subjects.map((subject) => subject.id);

test('overflow search rechecks positive and negated candidates beyond the sampled values through the API', async () => {
  const entries = [1, 2, 3, 4].map((n) =>
    book(n, [...filler(), by(n % 2 ? target : id(9999))], n > 2 ? { type: 'schema:Recipe' } : {}),
  );
  const env = await deployment(entries);
  const cases: { filter: FilterDocument; kept: number[]; points: number; text?: string }[] = [
    { filter: value(), kept: [0, 2], points: 4 },
    { filter: { not: value() }, text: 'book', kept: [1, 3], points: 4 },
    { filter: { and: [booksOnly, value()] }, kept: [0], points: 2 },
    { filter: { and: [booksOnly, { not: value() }] }, kept: [1], points: 2 },
    { filter: { or: [booksOnly, value()] }, kept: [0, 1, 2], points: 4 },
    { filter: { not: { and: [booksOnly, value()] } }, text: 'book', kept: [1, 2, 3], points: 4 },
    { filter: { not: { or: [booksOnly, value()] } }, text: 'book', kept: [3], points: 2 },
    { filter: { not: { and: [booksOnly, { not: value() }] } }, text: 'book', kept: [0, 2, 3], points: 4 },
    { filter: { saved: 'books/by-target' }, kept: [0], points: 2 },
  ];
  for (const { filter, kept, points, text } of cases) {
    const page = await env.search(filter, text ? { text } : {});
    expect(ids(page)).toEqual(kept.map((index) => entries[index]!.id));
    expect(page).not.toHaveProperty('total');
    expect(page.next).toBeNull();
    expect(page.subjects.every((s: { summary: unknown }) => s.summary === null)).toBe(true);
    expect(env.calls[0]!.params.overflow_properties).toEqual([author]);
    expect(env.probes.flatMap((call) => call.probes)).toHaveLength(points);
    expect(env.lineage.some((names) => names.some((name) => /^f\d+$/.test(name)))).toBe(true);
  }
  const unsupported = await env.request('search', { text: 'book', filter: { not: { not: value() } } });
  expect(unsupported.status).toBe(422);
  expect(await unsupported.json()).toMatchObject({ code: 'unsupported_query' });
});

test('overflow search preserves keyset continuation without aggregate metadata', async () => {
  const entries = Array.from({ length: 15 }, (_, n) => book(n + 1, [...filler(), by(n >= 12 ? target : id(9999))]));
  const env = await deployment(entries);
  const found: string[] = [];
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  let pages = 0;
  do {
    const page = await env.search(value(), { limit: 1, ...(cursor ? { cursor } : {}) });
    expect(page).not.toHaveProperty('total');
    expect(env.reads).toHaveLength(env.calls.length); // One batched anchor read per round in this partition.
    const afters = env.calls.flatMap((call) => (call.params.after ? [call.params.after[0]!] : []));
    expect(afters).toEqual([...afters].sort());
    found.push(...ids(page));
    if (pages === 0) {
      expect(page.subjects).toEqual([]);
      expect(env.calls).toHaveLength(3);
      expect(page.next).toEqual(expect.any(String));
      firstCursor = page.next;
    }
    cursor = page.next ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(found).toEqual(entries.slice(12).map((entry) => entry.id));
  const negated = await env.search({ and: [booksOnly, { not: value() }] }, { limit: 100 });
  expect(ids(negated)).toEqual(entries.slice(0, 12).map((entry) => entry.id));
  expect(negated).not.toHaveProperty('total');
  expect(env.calls[0]!.params.size).toBe(200);
  const changed = await env.request('search', { filter: value(), sort: 'id', limit: 2, cursor: firstCursor });
  expect(changed.status).toBe(400);
  expect(await changed.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/cursor', code: 'invalid_format' }],
  });
  await createSubjectIndex(engine, env.prefix, 2);
  await engine.request('POST', '/_aliases', {
    actions: [
      { remove: { index: env.index, alias: subjectAlias(env.prefix) } },
      { add: { index: subjectIndexName(env.prefix, 2), alias: subjectAlias(env.prefix) } },
    ],
  });
  const restarted = await env.request('search', { filter: value(), sort: 'id', limit: 1, cursor: firstCursor });
  expect(restarted.status).toBe(409);
  expect(await restarted.json()).toMatchObject({ code: 'search_restart_required' });
});

test('overflow facets exclude unresolved filter candidates without public counts', async () => {
  const env = await deployment([
    book(1, [by(target)]),
    book(2, [...filler(), by(target)]),
    book(3, [...filler(), by(id(9999))]),
    book(4, [by(id(9999))]),
  ]);
  const facets = [{ property: 'type' }, { property: author }];
  for (const filter of [value(), { saved: 'books/by-target' }]) {
    const response = await env.request('facets', { filter, facets });
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).not.toHaveProperty('total');
    expect(page.facets).toEqual([
      {
        property: 'type',
        values: [{ value: 'schema:Book', labels: { en: 'Book' } }],
      },
      { property: author, values: [{ value: target, labels: { en: 'Target' } }] },
    ]);
    for (const facet of page.facets) {
      expect(facet).not.toHaveProperty('relation');
      for (const value of facet.values) expect(value).not.toHaveProperty('count');
    }
    expect(env.calls).toHaveLength(1);
    expect(env.probes).toEqual([]);
  }
  const negative = await env.request('facets', {
    filter: { and: [booksOnly, { not: value() }] },
    facets: [{ property: 'type' }],
  });
  expect(negative.status).toBe(200);
  const negativeBody = await negative.json();
  expect(negativeBody).not.toHaveProperty('total');
  expect(negativeBody.facets).toEqual([
    { property: 'type', values: [{ value: 'schema:Book', labels: { en: 'Book' } }] },
  ]);
  // A sampled value outranks rare values in the bounded top-k. Give it an anchor for disclosure.
  const sampled = id(10000, '00b0');
  env.fake.put(
    book(10000, [], { id: sampled, type: 'schema:Person', labels: [{ language: 'en', value: 'Sampled author' }] }),
  );
  const typed = await env.request('facets', { filter: booksOnly, facets });
  expect(typed.status).toBe(200);
  const page = await typed.json();
  expect(page).not.toHaveProperty('total');
  expect(page.facets[0]).toEqual({
    property: 'type',
    values: [{ value: 'schema:Book', labels: { en: 'Book' } }],
  });
  expect(page.facets[1]).toEqual({
    property: author,
    values: [{ value: sampled, labels: { en: 'Sampled author' } }],
  });
  expect(env.calls).toHaveLength(1);
  expect(env.calls[0]!.params.has_overflow).toBeUndefined();
});

test('overflow search rejects qualified relations and keeps final security checks authoritative', async () => {
  const qualifiers = [role, language].map((q) => ({ property: q.property, value: q.in[0]! }));
  const entries = [
    book(1, [...filler(), by(id(9999))]),
    ...Array.from({ length: 7 }, (_, n) => book(n + 2, [...filler(), by(target, qualifiers)])),
  ];
  const env = await deployment(entries);
  const qualified = await env.request('search', { filter: value([role, language]) });
  expect(qualified.status).toBe(400);
  expect(await qualified.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/filter/statement/qualifiers', code: 'unsupported' }],
  });
  expect(env.calls).toEqual([]);
  expect(env.probes).toEqual([]);
  env.fake.put({ ...entries[2]!, visibility: 'hidden' });
  env.fake.put({ ...entries[3]!, visibility: 'taken_down' });
  env.fake.put({ ...entries[4]!, redirect: entries[1]!.id });
  env.fake.put({ ...entries[5]!, securityRevision: 2 });
  env.fake.remove(entries[6]!.id);
  const page = await env.search(value(), { limit: 2, descriptions: true, languages: ['en'] });
  expect(ids(page)).toEqual([entries[1]!.id, entries[7]!.id]);
  expect(page.subjects[0].descriptions).toEqual({ en: 'Current description' });
  expect(env.probes.flatMap((call) => call.probes).map((point) => point.subject)).toEqual([
    entries[0]!.id,
    entries[1]!.id,
    entries[7]!.id,
  ]);
  for (const point of env.probes.flatMap((call) => call.probes))
    expect(Object.keys(point).sort()).toEqual(['property', 'subject', 'value']);
  await engine.request(
    'POST',
    `/${env.index}/_update/${entries[7]!.id}`,
    { doc: { partition: 11 } },
    { query: { refresh: true } },
  );
  const readsBeforeCorruption = env.reads.length;
  const probesBeforeCorruption = env.probes.length;
  const malformed = await env.request('search', { filter: value() }, false);
  expect(malformed.status).toBe(503);
  expect(malformed.headers.get('retry-after')).toBe('1');
  const malformedBody = await malformed.json();
  expect(malformedBody).toMatchObject({ code: 'index_not_ready', status: 503 });
  expect(malformedBody).not.toHaveProperty('subjects');
  expect(env.reads).toHaveLength(readsBeforeCorruption);
  expect(env.probes).toHaveLength(probesBeforeCorruption);
  env.allow(false);
  const denied = await env.request('search', { filter: value() });
  expect(denied.status).toBe(403);
  expect(env.calls).toEqual([]);
});

test('overflow search fails the whole response closed when a point probe fails', async () => {
  const env = await deployment([book(1, [by(target)]), book(2, [...filler(), by(target)])]);
  env.fail(true);
  for (const filter of [value(), { and: [booksOnly, { not: value() }] }]) {
    const response = await env.request('search', { filter });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    const body = await response.json();
    expect(body).toMatchObject({ code: 'semantic_not_ready', retryable: true });
    expect(body.subjects).toBeUndefined();
    expect(env.probes).toHaveLength(1);
  }
});

test('search preserves visible hits without exposing engine totals or off-page overflow metadata', async () => {
  const env = await deployment([
    book(1, [by(target)]),
    book(2, [by(target)]),
    book(3, [by(target)]),
    book(4, [...filler(), by(id(9999))]),
  ]);
  const page = await env.search(value(), { limit: 1 });
  expect(ids(page)).toEqual([id(1)]);
  expect(page).not.toHaveProperty('total');
  expect(env.reads.flatMap((read) => read.ids)).not.toContain(id(4));
  const typed = await env.search(booksOnly, { limit: 1 });
  expect(typed).not.toHaveProperty('total');
  expect(env.calls[0]!.params.has_overflow).toBe(false);
  expect(env.probes).toEqual([]);
  const exact = await deployment([book(1, [by(target)]), book(2, [by(target)])]);
  expect(await exact.search(value(), { limit: 1 })).not.toHaveProperty('total');
  expect(exact.probes).toEqual([
    {
      partition: 10,
      probes: [
        { subject: id(1), property: author, value: target },
        { subject: id(2), property: author, value: target },
      ],
    },
  ]);
});

test('current checked overflow controls disclosed hits even when the indexed marker is absent', async () => {
  const entry = book(1, [by(target)]);
  const env = await deployment([entry]);
  for (const matches of [true, false]) {
    env.fake.put({ ...entry, statements: [...filler(), by(matches ? target : id(9999))] });
    const page = await env.search(value());
    expect(ids(page)).toEqual(matches ? [entry.id] : []);
    expect(page).not.toHaveProperty('total');
  }
});

test('overflow service work stays bounded at stored degrees 128, 512 and 2048', async () => {
  const operations: { rounds: number; reads: number; subjects: number; batches: number; probes: number }[] = [];
  for (const degree of [128, 512, 2048]) {
    const entries = [1, 2, 3].map((n) => book(n, [...filler(degree - 1), by(target)]));
    const env = await deployment(entries);
    const page = await env.search({ and: [value(), value()] }, { limit: 2 });
    expect(ids(page)).toEqual(entries.slice(0, 2).map((entry) => entry.id));
    expect(page).not.toHaveProperty('total');
    expect(env.calls[0]!.params.overflow_properties).toEqual([author]);
    operations.push({
      rounds: env.calls.length,
      reads: env.reads.length,
      subjects: env.reads.flatMap((read) => read.ids).length,
      batches: env.probes.length,
      probes: env.probes.flatMap((call) => call.probes).length,
    });
    const response = await env.request('facets', {
      filter: { and: [value(), value()] },
      facets: [{ property: 'type' }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('total');
    for (const facet of body.facets) {
      expect(facet).not.toHaveProperty('relation');
      for (const value of facet.values) expect(value).not.toHaveProperty('count');
    }
    expect(env.calls).toHaveLength(1);
    expect(env.reads).toEqual([]);
    expect(env.probes).toEqual([]);
  }
  expect(operations).toEqual([
    { rounds: 1, reads: 1, subjects: 3, batches: 1, probes: 3 },
    { rounds: 1, reads: 1, subjects: 3, batches: 1, probes: 3 },
    { rounds: 1, reads: 1, subjects: 3, batches: 1, probes: 3 },
  ]);
});
