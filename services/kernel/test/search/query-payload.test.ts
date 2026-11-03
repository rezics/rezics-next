import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  countFacets,
  FACET_TEMPLATE,
  HIT_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  suggestSubjects,
  type SearchPlan,
} from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';

const url = process.env.OPENSEARCH_URL;
const database = process.env.DATABASE_URL;
if (!url || !database) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const native = createOpenSearch(url);
const pool = createPool(database);
const prefix = `payload-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const id = '018f0000-0000-7000-8000-00a000000001';
const property = 'schema:author';
const marker = 'private-native-payload-marker';
const subject: IndexedSubject = {
  id,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 0,
  labels: [{ language: 'en', value: 'Kokoro' }],
  aliases: [],
  descriptions: [],
  statements: [{ property, value: id, facet: { kind: 'item' } }],
  relationFacetOverflow: [property],
};

// Paths address exactly one consumed field in a genuine native reply, never completion metadata.
type Body = Record<string, unknown>;
type Fault = { path: string; value?: unknown; grow?: number };
function field(body: Body, path: string): { parent: Body; key: string } {
  const parts = path.split('.');
  const key = parts.pop()!;
  let parent = body;
  for (const part of parts) parent = parent[part] as Body;
  return { parent, key };
}
function inject(body: Body, fault: Fault) {
  const { parent, key } = field(body, fault.path);
  if (fault.grow)
    parent[key] = Array.from({ length: fault.grow }, () => structuredClone((parent[key] as unknown[])[0]));
  else if (fault.value === undefined) delete parent[key];
  else parent[key] = fault.value;
}
function observe(fault?: Fault) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const replies: Body[] = [];
  const client: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      calls.push({ method, path, body: structuredClone(body) });
      const response = await native.request<T>(...args);
      if (!path.endsWith('/_search/template')) return response;
      const original = structuredClone(response.body) as Body;
      replies.push(original);
      expect(original).toMatchObject({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 } });
      const template = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : '';
      if (template.endsWith(SEARCH_TEMPLATE) || template.endsWith(FACET_TEMPLATE))
        expect((original.hits as Body).total).toMatchObject({ relation: 'eq' });
      if (template.endsWith(HIT_TEMPLATE)) expect((original.hits as Body).total).toBeUndefined();
      const changed = structuredClone(original);
      if (fault) inject(changed, fault);
      // Only the addressed payload field may differ, even for oversized replies.
      const restored = structuredClone(changed);
      if (fault) {
        const before = field(original, fault.path);
        const after = field(restored, fault.path);
        if (Object.hasOwn(before.parent, before.key))
          after.parent[after.key] = structuredClone(before.parent[before.key]);
        else delete after.parent[after.key];
      }
      expect(restored).toEqual(original);
      return { ...response, body: changed as T };
    },
    async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
      calls.push({ method: 'POST', path: '/_bulk', body: lines });
      return native.bulk<T>(lines, options);
    },
  };
  return { client, calls, replies };
}
const plan = (sort: SearchPlan['sort'] = 'id'): SearchPlan => ({
  sort,
  size: 1,
  generation: 1,
  overflowProperties: [property],
});
const facetPlan = (definite = false, empty = false) => ({
  ...(empty ? { filter: { bool: { must_not: [{ term: { type: 'schema:Book' } }] } } } : {}),
  ...(definite ? { overflowProperties: [property] } : {}),
  facets: [
    { property: 'type', size: 1 },
    { property, size: 1 },
  ],
  sample: 10,
});
type Operation = 'search' | 'suggest' | 'facet' | 'definite';
function run(operation: Operation, client: OpenSearch) {
  if (operation === 'search') return searchSubjects(client, prefix, plan());
  if (operation === 'suggest') return suggestSubjects(client, prefix, { text: 'Koko', size: 1 });
  return countFacets(client, prefix, facetPlan(operation === 'definite'));
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await createSubjectIndex(native, prefix, 1);
  const result = await native.bulk<{ errors: boolean }>(
    bulkLines(index, documentActions({ partition: 10, position: 1n, subjects: [subject] }, [id])),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
  // A native null name key is legal (also used for overlong normalized names).
  await native.request('POST', `/${index}/_update/${id}`, { doc: { name_sort: null } }, { query: { refresh: true } });
  await native.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  await installTemplates(native, prefix);
}, 120_000);

afterAll(async () => {
  try {
    await native.request('DELETE', `/${index}`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
      await native.request('DELETE', `/_scripts/${prefix}${name}`);
  } finally {
    await pool.end();
  }
});

test('an in-flight native search retains the original admitted generation and size', async () => {
  const input = plan();
  const observed = observe();
  const client: OpenSearch = {
    ...observed.client,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const response = await observed.client.request<T>(...args);
      if (args[1].endsWith('/_search/template')) {
        input.generation = 2;
        input.size = 2;
        input.sort = 'name';
        input.after = [null, id];
      }
      return response;
    },
  };
  const result = await searchSubjects(client, prefix, input);
  expect(result.generation).toBe(1);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]!.sort).toEqual([id]);
  expect(observed.calls).toHaveLength(1);
  expect(observed.calls[0]!.path).toBe(`/${index}/_search/template`);
  expect(input.generation).toBe(2);
});

test('bounded genuine search tuples preserve numeric zero, null names, generation and negative filters', async () => {
  for (const sort of ['id', 'name', 'collections', 'relevance'] as const) {
    const observed = observe();
    const result = await searchSubjects(observed.client, prefix, plan(sort));
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]!.path).toBe(`/${index}/_search/template`);
    expect(result).toMatchObject({ generation: 1, total: { value: 1, relation: 'exact' }, overflow: true });
    const tuple =
      sort === 'id' ? [id] : sort === 'name' ? [null, id] : sort === 'collections' ? [0, null, id] : [1, id];
    expect(result.hits).toEqual([{ id, index, partition: 10, securityRevision: 0, matched: [], sort: tuple }]);
    const empty = await searchSubjects(observed.client, prefix, {
      ...plan(sort),
      filter: { bool: { must_not: [{ term: { type: 'schema:Book' } }] } },
    });
    expect(empty).toEqual({ generation: 1, hits: [], total: { value: 0, relation: 'exact' }, overflow: false });
    expect(observed.calls).toHaveLength(2);
  }
});

test('genuine suggest and facet success and zero-hit replies retain internal counts', async () => {
  const observed = observe();
  expect(await suggestSubjects(observed.client, prefix, { text: 'Koko', size: 1 })).toEqual([
    { id, index, partition: 10, securityRevision: 0 },
  ]);
  expect(await suggestSubjects(observed.client, prefix, { text: 'unfindablepayloadtoken', size: 1 })).toEqual([]);
  for (const definite of [false, true]) {
    const counted = await countFacets(observed.client, prefix, facetPlan(definite));
    expect(counted).toEqual({
      total: { value: definite ? 0 : 1, relation: definite ? 'lower_bound' : 'exact' },
      facets: [
        {
          property: 'type',
          relation: definite ? 'lower_bound' : 'exact',
          values: definite ? [] : [{ value: 'schema:Book', count: 1 }],
        },
        { property, relation: 'lower_bound', values: definite ? [] : [{ value: id, count: 1 }] },
      ],
    });
    expect(await countFacets(observed.client, prefix, facetPlan(definite, true))).toEqual({
      total: { value: 0, relation: 'exact' },
      facets: [
        { property: 'type', relation: 'exact', values: [] },
        { property, relation: 'exact', values: [] },
      ],
    });
  }
  expect(observed.calls).toHaveLength(6);
});

const invalid = (path: string, values: unknown[]): Fault[] => values.map((value) => ({ path, value }));
const arrays = [undefined, null, {}, marker];
const counters = [undefined, null, -1, 0.5, '0', false, Number.MAX_SAFE_INTEGER + 1];
const hits = [
  ...invalid('hits', arrays),
  ...invalid('hits.hits', arrays),
  ...invalid('hits.hits.0', [null, marker]),
  ...invalid('hits.hits.0._id', [undefined, null, '', 17, marker]),
  ...invalid('hits.hits.0._index', [undefined, null, '', 17, 'foreign-subjects-g1']),
  ...invalid('hits.hits.0._source', arrays),
  ...invalid('hits.hits.0._source.partition', [...counters, 11, 4096]),
  ...invalid('hits.hits.0._source.security_revision', counters),
  { path: 'hits.hits', grow: 2 },
];
const totals = [
  ...invalid('hits.total', arrays),
  ...invalid('hits.total.value', counters),
  ...invalid('hits.total.relation', [undefined, null, marker, 'exact']),
];
const cases: { operation: Operation; fault: Fault }[] = [
  ...(['search', 'suggest'] as const).flatMap((operation) => hits.map((fault) => ({ operation, fault }))),
  ...[
    ...totals,
    ...invalid('hits.hits.0.sort', [...arrays, [], [id, id], [null], [7], [marker], [id, id, id]]),
    ...invalid('hits.hits.0.matched_queries', [null, {}, [17]]),
    ...invalid('aggregations', arrays),
    ...invalid('aggregations.overflow', arrays),
    ...invalid('aggregations.overflow.doc_count', counters),
  ].map((fault) => ({ operation: 'search' as const, fault })),
  ...[
    ...totals,
    ...invalid('aggregations', arrays),
    ...['facet_0', 'facet_1', 'overflow_0', 'overflow_1'].flatMap((node) => invalid(`aggregations.${node}`, arrays)),
    ...['overflow_0', 'overflow_1'].flatMap((node) => invalid(`aggregations.${node}.doc_count`, counters)),
    ...['facet_0.values', 'facet_1.facts', 'facet_1.facts.property', 'facet_1.facts.property.values'].flatMap((node) =>
      invalid(`aggregations.${node}`, arrays),
    ),
    ...['facet_0.values', 'facet_1.facts.property.values'].flatMap((node) => [
      ...invalid(`aggregations.${node}.buckets`, arrays),
      ...invalid(`aggregations.${node}.buckets.0.key`, [undefined, null, 17, {}]),
      { path: `aggregations.${node}.buckets`, grow: 3 },
    ]),
    ...invalid('aggregations.facet_0.values.buckets.0.doc_count', counters),
    ...invalid('aggregations.facet_1.facts.property.values.buckets.0.subjects', arrays),
    ...invalid('aggregations.facet_1.facts.property.values.buckets.0.subjects.doc_count', counters),
  ].map((fault) => ({ operation: 'facet' as const, fault })),
  ...[
    ...invalid('aggregations.definite', arrays),
    ...invalid('aggregations.definite.doc_count', counters),
    ...invalid('aggregations.definite.facet_0', arrays),
    ...invalid('aggregations.definite.facet_1', arrays),
    ...invalid('aggregations.filter_overflow', arrays),
    ...invalid('aggregations.filter_overflow.doc_count', counters),
  ].map((fault) => ({ operation: 'definite' as const, fault })),
];
for (const [number, { operation, fault }] of cases.entries()) {
  test(`malformed native query payloads cannot become empty success or untyped failure: ${operation} ${number} ${fault.path}`, async () => {
    const observed = observe(fault);
    const outcome = await run(operation, observed.client).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(observed.calls).toHaveLength(1);
    expect(observed.replies).toHaveLength(1);
    expect('error' in outcome ? outcome.error : outcome).toBeInstanceOf(SearchUnavailableError);
  });
}

for (const sort of ['name', 'collections', 'relevance'] as const) {
  for (const value of [undefined, [], [id], [null, id, id], [false, id], [null, 17]]) {
    test(`${sort} rejects a malformed required sort tuple ${JSON.stringify(value)}`, async () => {
      const observed = observe({ path: 'hits.hits.0.sort', value });
      await expect(searchSubjects(observed.client, prefix, plan(sort))).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(observed.calls).toHaveLength(1);
    });
  }
}

test('suggest does not require unconsumed totals sort or matched query fields', async () => {
  for (const path of ['hits.total', 'hits.hits.0.sort', 'hits.hits.0.matched_queries']) {
    const observed = observe({ path });
    expect(await run('suggest', observed.client)).toEqual([{ id, index, partition: 10, securityRevision: 0 }]);
    expect(observed.calls).toHaveLength(1);
  }
});

const serviceFaults = [
  { name: 'malformed search hits', operation: 'search' as const, fault: { path: 'hits.hits', value: marker } },
  { name: 'malformed suggest hits', operation: 'suggest' as const, fault: { path: 'hits.hits', value: marker } },
  {
    name: 'inexact physical identity',
    operation: 'search' as const,
    fault: { path: 'hits.hits.0._index', value: 'foreign-subjects-g1' },
  },
  { name: 'duplicate native roots', operation: 'search' as const, fault: { path: 'hits.hits', grow: 2 } },
];
for (const { name, operation, fault } of serviceFaults) {
  test(`actual service maps ${name} to index_not_ready 503 before Source`, async () => {
    const observed = observe(fault);
    let reads = 0;
    const denied = async (): Promise<never> => {
      reads++;
      throw new Error('Source must not be reached');
    };
    // Negative protocol evidence only: no successful Source, freshness or permission outcome is supplied.
    const source: SubjectSource = { read: denied, count: denied, matchRelationFacets: denied };
    const service = createSearchService({
      pool,
      client: observed.client,
      prefix,
      source,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) },
    });
    const pending =
      operation === 'search' ? service.search('anonymous', { text: 'kokoro' }) : service.suggest('Koko');
    const outcome = await pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(reads).toBe(0);
    expect(observed.replies).toHaveLength(1);
    expect(observed.calls.filter(({ path }) => path.endsWith('/_search/template'))).toHaveLength(1);
    const resolvePath = `/_resolve/index/${prefix}subjects*`;
    const mappingPath = `/${index}/_mapping`;
    for (const metadataPath of [resolvePath, mappingPath])
      expect(
        observed.calls.filter(({ method, path }) => method === 'GET' && path === metadataPath).length,
      ).toBeLessThanOrEqual(1);
    expect(
      observed.calls.every(
        ({ method, path }) =>
          ((method === 'PUT' || method === 'GET') && path.startsWith('/_scripts/')) ||
          path.endsWith('/_search/template') ||
          (method === 'GET' && (path === resolvePath || path === mappingPath)),
      ),
    ).toBe(true);
    const error = 'error' in outcome ? outcome.error : outcome;
    const response = problemResponse(error, { method: 'GET', id: 'payload-test' });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'index_not_ready', status: 503 });
    expect(body).not.toContain(marker);
    expect(body).not.toContain(id);
    expect(body).not.toContain(index);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
  });
}

for (const operation of ['search', 'suggest'] as const) {
  test(`actual service rejects valid-range wrong-partition ${operation} payload before Source`, async () => {
    const observed = observe({ path: 'hits.hits.0._source.partition', value: 11 });
    let reads = 0;
    const denied = async (): Promise<never> => {
      reads++;
      throw new Error('Source must not be reached');
    };
    const source: SubjectSource = { read: denied, count: denied, matchRelationFacets: denied };
    const service = createSearchService({
      pool,
      client: observed.client,
      prefix,
      source,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) },
    });
    const pending = operation === 'search' ? service.search('anonymous', { text: 'kokoro' }) : service.suggest('Koko');
    const outcome = await pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(reads).toBe(0);
    expect(observed.replies).toHaveLength(1);
    expect(observed.calls.filter(({ path }) => path.endsWith('/_search/template'))).toHaveLength(1);
    const error = 'error' in outcome ? outcome.error : outcome;
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
    const response = problemResponse(error, { method: 'GET', id: 'partition-payload-test' });
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toMatchObject({ code: 'index_not_ready', status: 503 });
  });
}
