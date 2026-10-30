import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { newId } from '../../src/route/route.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import {
  countFacets,
  suggestSubjects,
  FACET_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  type SearchPlan,
  searchSubjects,
  SUGGEST_TEMPLATE,
} from '../../src/search/query.ts';
import { type IndexedSubject, subjectPartition } from '../../src/search/source.ts';
import { createSearchService } from '../../src/search/service.ts';
import { createFakeSource } from './support/fake-source.ts';
import { captureMetadata, mappingControls, resolveControls } from './support/native-metadata.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const engine = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const alias = subjectAlias(prefix);
const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7()].sort();
const overflowProperty = 'schema:author';
const sorts = ['relevance', 'name', 'id', 'collections'] as const satisfies readonly SearchPlan['sort'][];
// This additive input is deliberately isolated from Semantic identity and service readiness.
type GenerationPlan = SearchPlan & { generation?: number };
type NativeResponse = {
  hits: {
    hits: {
      _id: string;
      _index: string;
      _source: { partition: number; security_revision: number };
      matched_queries: string[];
      sort: (string | number | null)[];
    }[];
    total: { value: number; relation: 'eq' | 'gte' };
  };
  aggregations: { overflow: { doc_count: number } };
};

function transport() {
  const calls: { method: string; path: string; body: unknown; response?: unknown }[] = [];
  const search: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      const call: (typeof calls)[number] = { method, path, body };
      calls.push(call);
      const response = await engine.request<T>(...args);
      call.response = response.body;
      return response;
    },
    bulk: (lines, options) => engine.bulk(lines, options),
  };
  return { search, calls };
}

async function seed(generation: number) {
  await createSubjectIndex(engine, prefix, generation);
  for (const [offset, id] of ids.entries()) {
    const subject: IndexedSubject = {
      id,
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: generation === 1 ? 17 : 29,
      labels: [{ language: 'en', value: `${generation === 1 ? 'Amber' : 'Violet'} lantern ${offset}` }],
      aliases: [],
      descriptions: [],
      statements: [],
      relationFacetOverflow: generation === 1 ? [overflowProperty] : [],
    };
    const actions = documentActions(
      { partition: subjectPartition(id), position: 1n, subjects: [subject] },
      [id],
      new Map([[id, offset + generation]]),
    );
    const result = await engine.bulk<{ errors: boolean }>(bulkLines(subjectIndexName(prefix, generation), actions), {
      query: { refresh: 'wait_for' },
    });
    expect(result.errors).toBe(false);
  }
}

async function switchAlias(from: number, to: number) {
  await engine.request('POST', '/_aliases', {
    actions: [
      { remove: { index: subjectIndexName(prefix, from), alias } },
      { add: { index: subjectIndexName(prefix, to), alias } },
    ],
  });
}

const plan = (sort: SearchPlan['sort']): SearchPlan => ({
  query: { match: { search_text: { query: 'lantern', _name: 'generation-text' } } },
  filter: { term: { type: 'schema:Book' } },
  sort,
  size: 10,
  overflowProperties: [overflowProperty],
});

// Assert decoded fields against this call's native response, without issuing a reference query at runtime.
async function read(input: GenerationPlan, generation: number, target: string) {
  const { search, calls } = transport();
  const result = await searchSubjects(search, prefix, input);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'POST', path: `/${target}/_search/template` });
  const native = calls[0]!.response as NativeResponse;
  expect(native.hits.total).toEqual({ value: 2, relation: 'eq' });
  expect(result.total).toEqual({ value: 2, relation: 'exact' });
  expect(result.hits).toEqual(
    native.hits.hits.map((hit) => ({
      id: hit._id,
      index: hit._index,
      partition: hit._source.partition,
      securityRevision: hit._source.security_revision,
      matched: hit.matched_queries,
      sort: hit.sort,
    })),
  );
  expect(result.hits.map(({ id }) => id).sort()).toEqual(ids);
  for (const hit of result.hits) {
    expect(hit.index).toBe(subjectIndexName(prefix, generation));
    expect(hit.partition).toBe(subjectPartition(hit.id));
    expect(hit.securityRevision).toBe(generation === 1 ? 17 : 29);
    expect(hit.matched).toEqual(['generation-text']);
    expect(hit.sort).toHaveLength(input.sort === 'collections' ? 3 : input.sort === 'id' ? 1 : 2);
    expect(hit.sort.at(-1)).toBe(hit.id);
    if (input.sort === 'name' || input.sort === 'collections') {
      expect(hit.sort.at(-2)).toBe(`${generation === 1 ? 'amber' : 'violet'} lantern ${ids.indexOf(hit.id)}`);
    }
    if (input.sort === 'collections') expect(hit.sort[0]).toBe(ids.indexOf(hit.id) + generation);
    if (input.sort === 'relevance') expect(Number(hit.sort[0])).toBeGreaterThan(0);
  }
  expect(native.aggregations.overflow.doc_count).toBe(generation === 1 ? 2 : 0);
  expect(result.overflow).toBe(generation === 1);
  return result;
}

beforeAll(async () => {
  await seed(1);
  await seed(2);
  await installTemplates(engine, prefix);
  await engine.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 2), alias } }],
  });
  // Establish a legal native baseline before testing the additive generation contract.
  for (const sort of sorts) await read(plan(sort), 2, alias);
}, 120_000);

afterAll(async () => {
  for (const generation of [1, 2]) {
    await engine.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
    await engine.request('DELETE', `/_scripts/${prefix}${template}`);
  }
});

test('ordinary Search plans can use one validated physical generation including zero hits without silently falling back to the alias', async () => {
  for (const sort of sorts) {
    const result = await read({ ...plan(sort), generation: 1 }, 1, subjectIndexName(prefix, 1));
    expect(result).toMatchObject({ generation: 1 });
    const current = await read({ ...plan(sort), generation: 2 }, 2, subjectIndexName(prefix, 2));
    expect(current).toMatchObject({ generation: 2 });
  }
});

test('an explicit generation survives a real alias switch between calls', async () => {
  const pinned: GenerationPlan = { ...plan('name'), generation: 2 };
  let switched = false;
  try {
    await read(pinned, 2, subjectIndexName(prefix, 2));
    await switchAlias(2, 1);
    switched = true;
    await read(plan('name'), 1, alias);
    await read(pinned, 2, subjectIndexName(prefix, 2));
  } finally {
    if (switched) await switchAlias(1, 2);
  }
});

test('zero native hits retain the explicitly selected generation for every nonrating sort', async () => {
  for (const sort of sorts) {
    const { search, calls } = transport();
    const input: GenerationPlan = {
      ...plan(sort),
      generation: 1,
      query: { match: { search_text: 'violet' } },
    };
    const result = await searchSubjects(search, prefix, input);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/${subjectIndexName(prefix, 1)}/_search/template`);
    expect(result).toMatchObject({ generation: 1, hits: [], total: { value: 0, relation: 'exact' }, overflow: false });
    expect(calls[0]!.response).toMatchObject({ hits: { hits: [], total: { value: 0, relation: 'eq' } } });
  }
});

test('invalid explicit generations reject before any transport I/O', async () => {
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
    const { search, calls } = transport();
    const input: GenerationPlan = { ...plan('id'), generation };
    const failure = await Promise.resolve()
      .then(() => searchSubjects(search, prefix, input))
      .catch((error: unknown) => error);
    expect(calls).toEqual([]);
    expect(failure).toBeInstanceOf(RangeError);
  }
});

test('missing and retired generations fail against their physical target without alias fallback', async () => {
  async function missing(generation: number) {
    const { search, calls } = transport();
    const input: GenerationPlan = { ...plan('id'), generation };
    const failure = await searchSubjects(search, prefix, input).catch((error: unknown) => error);
    expect(calls.map(({ path }) => path)).toEqual([`/${subjectIndexName(prefix, generation)}/_search/template`]);
    expect(failure).toBeInstanceOf(OpenSearchError);
    expect(failure).toMatchObject({ status: 404, type: 'index_not_found_exception' });
  }
  await missing(77);
  await engine.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
  try {
    await missing(1);
    await read(plan('id'), 2, alias);
  } finally {
    await seed(1);
  }
});

test('generation selection uses the unchanged released stored template', async () => {
  expect(SEARCH_TEMPLATE).toBe('subjects-search-v2');
  const released = JSON.parse(
    readFileSync(new URL('../../db/search/templates/subjects-search-v2.json', import.meta.url), 'utf8'),
  ) as { script: { lang: string; source: string } };
  const { body } = await engine.request<{ script: unknown }>('GET', `/_scripts/${prefix}${SEARCH_TEMPLATE}`);
  expect(body.script).toEqual(released.script);
});

const metadataPool = createPool(process.env.DATABASE_URL!);
afterAll(() => metadataPool.end());

function metadataService(client: OpenSearch) {
  const fake = createFakeSource();
  for (const [offset, id] of ids.entries())
    fake.put({
      id,
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 17,
      labels: [{ language: 'en', value: `Amber lantern ${offset}` }],
      aliases: [],
      descriptions: [],
      statements: [],
    });
  let sourceWork = 0;
  const service = createSearchService({
    pool: metadataPool,
    client,
    prefix,
    source: {
      read: (...args) => {
        sourceWork++;
        return fake.read(...args);
      },
      count: (...args) => {
        sourceWork++;
        return fake.count(...args);
      },
    },
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
  });
  return { service, sourceWork: () => sourceWork };
}

async function metadataProblem(promise: Promise<unknown>, code = 'index_not_ready') {
  const error: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ProblemError);
  expect(error).toMatchObject({ code });
  const response = problemResponse(error as ProblemError, { method: 'POST', id: 'native-metadata' });
  expect(response.status).toBe(code === 'index_not_ready' ? 503 : 409);
  const body: unknown = await response.json();
  for (const field of ['subjects', 'next', 'as_of', 'total']) expect(body).not.toHaveProperty(field);
}

test('actual query callers refuse malformed native start and final resolve metadata, including empty hits and would-be cursors', async () => {
  await switchAlias(2, 1);
  try {
    for (const control of resolveControls(prefix)) {
      for (const boundary of ['start', 'populated final', 'empty final'] as const) {
        const start = boundary === 'start';
        const empty = boundary === 'empty final';
        const { client, calls } = captureMetadata(engine, 'resolve', control, start ? 1 : 2);
        const { service, sourceWork } = metadataService(client);
        await metadataProblem(
          service.search('anonymous', { text: empty ? 'nohit' : 'lantern', sort: 'name', limit: 1 }),
        );
        const resolves = calls.filter(({ path }) => path.startsWith('/_resolve/index/'));
        const mappings = calls.filter(({ path }) => path.endsWith('/_mapping'));
        const queries = calls.filter(({ path }) => path.endsWith('/_search/template'));
        expect(resolves, control.name).toHaveLength(start ? 1 : 2);
        expect(
          mappings.map(({ path }) => path),
          control.name,
        ).toEqual(start ? [] : [`/${subjectIndexName(prefix, 1)}/_mapping`]);
        expect(
          queries.map(({ path }) => path),
          control.name,
        ).toEqual(start ? [] : [`/${subjectIndexName(prefix, 1)}/_search/template`]);
        expect(resolves.at(-1)!.changed, control.name).toBeDefined();
        if (start || empty) expect(sourceWork(), control.name).toBe(0);
        else expect(sourceWork(), control.name).toBeGreaterThan(0);
        if (!start) {
          const receipt = queries[0]!.raw!.body as NativeResponse;
          expect(receipt.hits.hits.length, control.name).toBe(empty ? 0 : 2);
          expect(receipt.hits.total).toEqual({ value: empty ? 0 : 2, relation: 'eq' });
        }
      }
    }
  } finally {
    await switchAlias(1, 2);
  }
}, 120_000);

test('actual query callers refuse malformed concrete mapping receipts before native search or Source reads', async () => {
  await switchAlias(2, 1);
  try {
    for (const control of mappingControls(subjectIndexName(prefix, 1))) {
      const { client, calls } = captureMetadata(engine, 'mapping', control);
      const { service, sourceWork } = metadataService(client);
      await metadataProblem(service.search('anonymous', { text: 'lantern', sort: 'name', limit: 1 }));
      expect(
        calls.filter(({ path }) => path.startsWith('/_resolve/index/')),
        control.name,
      ).toHaveLength(1);
      expect(
        calls.filter(({ path }) => path.endsWith('/_mapping')),
        control.name,
      ).toHaveLength(1);
      expect(
        calls.filter(({ path }) => path.endsWith('/_search/template')),
        control.name,
      ).toEqual([]);
      expect(sourceWork(), control.name).toBe(0);
    }
  } finally {
    await switchAlias(1, 2);
  }
}, 120_000);

test('native caller generation switches preserve pinned requests and restart409 for populated, empty and continuation pages', async () => {
  await switchAlias(2, 1);
  try {
    const { client: baseline, calls: baselineCalls } = captureMetadata(engine, 'resolve');
    const { service } = metadataService(baseline);
    const request = { text: 'lantern', sort: 'name', limit: 1 } as const;
    const first = await service.search('anonymous', request);
    expect(first.subjects).toHaveLength(1);
    expect(first.next).toBeString();
    expect(baselineCalls.filter(({ path }) => path.startsWith('/_resolve/index/'))).toHaveLength(2);
    expect(baselineCalls.filter(({ path }) => path.endsWith('/_search/template'))).toHaveLength(1);
    console.info('native query metadata baseline', JSON.stringify(baselineCalls));
    for (const scenario of [request, { ...request, text: 'nohit' }, { ...request, cursor: first.next! }]) {
      let switched = false;
      const { client, calls } = captureMetadata(engine, 'resolve');
      const racing: OpenSearch = {
        bulk: (...args) => client.bulk(...args),
        async request<T>(...args: Parameters<OpenSearch['request']>) {
          const receipt = await client.request<T>(...args);
          if (args[1].endsWith('/_mapping') && !switched) {
            await switchAlias(1, 2);
            switched = true;
          }
          return receipt;
        },
      };
      try {
        await metadataProblem(metadataService(racing).service.search('anonymous', scenario), 'search_restart_required');
        expect(switched).toBe(true);
        expect(calls.filter(({ path }) => path.startsWith('/_resolve/index/'))).toHaveLength(2);
        expect(calls.filter(({ path }) => path.endsWith('/_search/template')).map(({ path }) => path)).toEqual([
          `/${subjectIndexName(prefix, 1)}/_search/template`,
        ]);
        const old = calls.find(({ path }) => path.startsWith('/_resolve/index/'))!.raw!.body;
        const current = calls.findLast(({ path }) => path.startsWith('/_resolve/index/'))!.raw!.body;
        expect(old).toMatchObject({ aliases: [{ name: alias, indices: [subjectIndexName(prefix, 1)] }] });
        expect(current).toMatchObject({ aliases: [{ name: alias, indices: [subjectIndexName(prefix, 2)] }] });
      } finally {
        if (switched) await switchAlias(2, 1);
      }
    }
    await switchAlias(1, 2);
    try {
      await metadataProblem(
        service.search('anonymous', { ...request, cursor: first.next! }),
        'search_restart_required',
      );
    } finally {
      await switchAlias(2, 1);
    }
  } finally {
    await switchAlias(1, 2);
  }
}, 120_000);

// These controls share this suite's managed database, native node and owned prefix.
// Successful engine work always executes natively; only malformed metadata is cloned.
describe('native discovery generation custody', () => {
  const property = 'schema:author';
  const release = {
    types: { 'schema:Book': { facets: [property], labels: { en: 'Book' } } },
    properties: { [property]: { datatype: 'wikibase-item' } },
  };
  const source = createFakeSource();
  const books: IndexedSubject[] = [];
  const authors: IndexedSubject[] = [];
  const stamps = ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:05.000Z'];
  const operations = ['suggest', 'facets'] as const;
  type Operation = (typeof operations)[number];
  const facetPlan = (empty = false) => ({
    text: empty ? 'absentcustody' : 'custody',
    filter: { type: { in: ['schema:Book'] } },
    facets: [{ property, size: 1 }],
  });

  beforeAll(async () => {
    for (const generation of [1, 2]) {
      const author: IndexedSubject = {
        id: newId(160),
        type: 'schema:Person',
        visibility: 'visible',
        redirect: null,
        securityRevision: 1,
        labels: [{ language: 'en', value: `Author ${generation}` }],
        aliases: [],
        descriptions: [],
        statements: [],
      };
      const book: IndexedSubject = {
        ...author,
        id: newId(160),
        type: 'schema:Book',
        labels: [{ language: 'en', value: `Custody ${generation}` }],
        statements: [{ property, value: author.id, facet: { kind: 'item' } }],
      };
      authors.push(author);
      books.push(book);
      source.put(author);
      source.put(book);
      const result = await engine.bulk<{ errors: boolean }>(
        bulkLines(
          subjectIndexName(prefix, generation),
          documentActions({ partition: 10, position: 1n, subjects: [book] }, [book.id]),
        ),
        { query: { refresh: 'wait_for' } },
      );
      expect(result.errors).toBe(false);
      // Give each actual generation a different real consumer watermark.
      await metadataPool.query(
        `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
        SELECT partition_no, $1, CASE WHEN position = 0 THEN NULL ELSE epoch END, position FROM core.partition
        ON CONFLICT (partition_no, consumer) DO UPDATE SET epoch = EXCLUDED.epoch, position = EXCLUDED.position`,
        [subjectConsumer(prefix, generation)],
      );
    }
    const client = await metadataPool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ epoch: number; position: string }>(
        'UPDATE core.partition SET position = position + 2 WHERE partition_no = 901 RETURNING epoch, position::text',
      );
      const { epoch, position } = rows[0]!;
      for (const [offset, stamp] of stamps.entries()) {
        await client.query(
          `INSERT INTO core.outbox
          (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
          VALUES (901, $1, 0, 1, $2, $3, 'com.rezics.subject.created.v1', $4, '{}'::jsonb, $5)`,
          [BigInt(position) - 1n + BigInt(offset), epoch, crypto.randomUUID(), books[offset]!.id, stamp],
        );
      }
      await client.query(
        'UPDATE core.consumer_checkpoint SET position = $1, epoch = $2 WHERE partition_no = 901 AND consumer = $3',
        [BigInt(position) - 1n, epoch, subjectConsumer(prefix, 2)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await metadataPool.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1::text[])', [
      [subjectConsumer(prefix, 1), subjectConsumer(prefix, 2)],
    ]);
  });

  function observed(
    options: {
      client?: OpenSearch;
      onNative?: (path: string) => Promise<void>;
      onSource?: () => Promise<void>;
      onFreshness?: () => Promise<void>;
    } = {},
  ) {
    const events: string[] = [];
    const reads: { partition: number; ids: readonly string[] }[] = [];
    const consumers: string[] = [];
    const receipts: { path: string; bytes: number; body: unknown }[] = [];
    const underlying = options.client ?? engine;
    const client: OpenSearch = {
      bulk: (...args) => underlying.bulk(...args),
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await underlying.request<T>(...args);
        events.push(args[1]);
        receipts.push({ path: args[1], bytes: Buffer.byteLength(JSON.stringify(response)), body: response.body });
        await options.onNative?.(args[1]);
        return response;
      },
    };
    const pool = new Proxy(metadataPool, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key, target);
        return async (...args: Parameters<typeof target.query>) => {
          const config = args[0] as unknown as { text?: string; values?: readonly string[] };
          const parameters = typeof args[0] === 'string' ? (args[1] as unknown as readonly string[]) : config.values;
          const text = typeof args[0] === 'string' ? args[0] : config.text;
          const freshness = text?.includes('consumer_checkpoint') === true;
          if (freshness) {
            events.push('freshness');
            consumers.push(parameters![0]!);
          }
          const result = await (target.query as (...args: unknown[]) => Promise<unknown>)(...args);
          if (freshness) await options.onFreshness?.();
          return result;
        };
      },
    });
    const service = createSearchService({
      pool,
      client,
      prefix,
      source: {
        async read(partition, ids) {
          events.push('source');
          reads.push({ partition, ids: [...ids] });
          const snapshot = await source.read(partition, ids);
          await options.onSource?.();
          return snapshot;
        },
        async count() {
          throw new Error('Discovery must not enumerate Source');
        },
      },
      release: async () => release,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
    });
    return { service, events, reads, consumers, receipts };
  }
  type Observation = ReturnType<typeof observed>;
  function invoke(probe: Observation, operation: Operation, empty = false) {
    return operation === 'suggest'
      ? probe.service.suggest(empty ? 'absentcustody' : 'custody', 1, ['en'])
      : probe.service.facets('anonymous', { ...facetPlan(empty), languages: ['en'] });
  }
  function assertWork(probe: Observation, generation: number, empty: boolean, operation: Operation) {
    const resolves = probe.events.filter((path) => path.startsWith('/_resolve/index/'));
    expect(resolves).toHaveLength(2);
    expect(probe.events.filter((path) => path.endsWith('/_mapping'))).toEqual([
      `/${subjectIndexName(prefix, generation)}/_mapping`,
    ]);
    expect(probe.events.filter((path) => path.endsWith('/_search/template'))).toEqual([
      `/${subjectIndexName(prefix, generation)}/_search/template`,
    ]);
    expect(probe.events.at(-1)).toBe(resolves[1]);
    expect(probe.events.indexOf('freshness')).toBeGreaterThan(
      probe.events.findIndex((path) => path.endsWith('/_search/template')),
    );
    expect(probe.consumers).toEqual([subjectConsumer(prefix, generation)]);
    expect(probe.reads).toEqual(
      empty
        ? []
        : [
            {
              partition: 10,
              ids: [(operation === 'suggest' ? books : authors)[generation - 1]!.id],
            },
          ],
    );
    if (!empty) expect(probe.events.indexOf('source')).toBeLessThan(probe.events.indexOf('freshness'));
    const native = probe.receipts.find(({ path }) => path.endsWith('/_search/template'))!.body;
    if (operation === 'suggest')
      expect(native).toMatchObject({
        hits: { hits: empty ? [] : [{ _index: subjectIndexName(prefix, generation), _id: books[generation - 1]!.id }] },
      });
    else
      expect(native).toMatchObject({
        hits: { total: { value: empty ? 0 : 1, relation: 'eq' } },
        aggregations: {
          facet_0: {
            facts: {
              property: {
                values: { buckets: empty ? [] : [{ key: authors[generation - 1]!.id, subjects: { doc_count: 1 } }] },
              },
            },
          },
        },
      });
  }
  async function discoveryProblem(promise: Promise<unknown>, code = 'index_not_ready') {
    const error: unknown = await promise.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ code });
    const response = problemResponse(error as ProblemError, { method: 'POST', id: 'discovery' });
    expect(response.status).toBe(code === 'index_not_ready' ? 503 : 409);
    const body: unknown = await response.json();
    for (const field of ['subjects', 'facets', 'values', 'next', 'total', 'as_of'])
      expect(body).not.toHaveProperty(field);
  }
  async function atFirst(work: () => Promise<void>) {
    await switchAlias(2, 1);
    try {
      await work();
    } finally {
      await switchAlias(1, 2);
    }
  }

  test('both native discovery callers own same-generation and empty watermarks across real alias changes', async () => {
    for (const generation of [2, 1]) {
      if (generation === 1) await switchAlias(2, 1);
      try {
        for (const operation of operations)
          for (const empty of [false, true]) {
            const probe = observed();
            const answer = await invoke(probe, operation, empty);
            assertWork(probe, generation, empty, operation);
            expect(answer.as_of).toBe(stamps[generation - 1]!);
            if ('subjects' in answer)
              expect(answer.subjects).toEqual(
                empty
                  ? []
                  : [
                      {
                        id: books[generation - 1]!.id,
                        type: 'schema:Book',
                        labels: { en: `Custody ${generation}` },
                      },
                    ],
              );
            else
              expect(answer).toEqual({
                as_of: stamps[generation - 1]!,
                facets: [
                  {
                    property,
                    values: empty
                      ? []
                      : [
                          {
                            value: authors[generation - 1]!.id,
                            labels: { en: `Author ${generation}` },
                          },
                        ],
                  },
                ],
              });
          }
      } finally {
        if (generation === 1) await switchAlias(1, 2);
      }
    }
  });

  test('native discovery pins before start switches and rejects switches during query, Source and freshness even with empty results', async () => {
    await atFirst(async () => {
      for (const operation of operations)
        for (const boundary of ['start', 'query', 'source', 'freshness'] as const) {
          for (const empty of boundary === 'source' ? [false] : [false, true]) {
            let switched = false;
            const switchOnce = async () => {
              if (!switched) {
                await switchAlias(1, 2);
                switched = true;
              }
            };
            const probe = observed({
              onNative: async (path) => {
                if (
                  (boundary === 'start' && path.startsWith('/_resolve/index/')) ||
                  (boundary === 'query' && path.endsWith('/_search/template'))
                )
                  await switchOnce();
              },
              ...(boundary === 'source' ? { onSource: switchOnce } : {}),
              ...(boundary === 'freshness' ? { onFreshness: switchOnce } : {}),
            });
            try {
              await discoveryProblem(invoke(probe, operation, empty), 'search_restart_required');
              expect(switched).toBe(true);
              assertWork(probe, 1, empty, operation);
            } finally {
              if (switched) await switchAlias(2, 1);
            }
          }
        }
    });
  }, 120_000);

  test('a discovery final observation cannot reuse another request’s in-flight start observation', async () => {
    const gate = () => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      return { promise, open };
    };
    await atFirst(async () => {
      for (const operation of operations) {
        const sourceEntered = gate(),
          sourceRelease = gate(),
          startEntered = gate(),
          startRelease = gate();
        let resolves = 0,
          sourceCalls = 0,
          freshnessCalls = 0,
          switched = false;
        const probe = observed({
          async onNative(path) {
            if (path.startsWith('/_resolve/index/') && ++resolves === 2) {
              startEntered.open();
              await startRelease.promise;
            }
          },
          async onSource() {
            if (++sourceCalls === 1) {
              sourceEntered.open();
              await sourceRelease.promise;
            }
          },
          async onFreshness() {
            if (++freshnessCalls === 1) {
              await switchAlias(1, 2);
              switched = true;
            }
          },
        });
        const first = discoveryProblem(invoke(probe, operation), 'search_restart_required');
        let second: Promise<void> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await sourceEntered.promise;
          second = discoveryProblem(invoke(probe, operation), 'search_restart_required');
          await startEntered.promise;
          sourceRelease.open();
          await Promise.race([
            first,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Final observation waited on another request’s start')),
                5_000,
              );
            }),
          ]);
          expect(resolves).toBe(3);
        } finally {
          if (timeout) clearTimeout(timeout);
          sourceRelease.open();
          startRelease.open();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
          if (switched) await switchAlias(2, 1);
        }
        expect(resolves).toBe(4);
      }
    });
  }, 30_000);

  test('both discovery callers reject every malformed actual native start and final receipt with no public payload', async () => {
    await atFirst(async () => {
      for (const operation of operations)
        for (const control of resolveControls(prefix)) {
          for (const boundary of ['start', 'final', 'empty final'] as const) {
            const start = boundary === 'start',
              empty = boundary === 'empty final';
            const capture = captureMetadata(engine, 'resolve', control, start ? 1 : 2);
            const probe = observed({ client: capture.client });
            await discoveryProblem(invoke(probe, operation, empty));
            expect(capture.calls.filter(({ changed }) => changed)).toHaveLength(1);
            if (start) {
              expect(probe.events.filter((path) => path.endsWith('/_search/template'))).toEqual([]);
              expect(probe.events.filter((path) => path.endsWith('/_mapping'))).toEqual([]);
              expect(probe.reads).toEqual([]);
              expect(probe.consumers).toEqual([]);
            } else {
              // Rejections may throw before the outer recorder sees the final receipt.
              expect(capture.calls.filter(({ path }) => path.startsWith('/_resolve/index/'))).toHaveLength(2);
              expect(probe.consumers).toEqual([subjectConsumer(prefix, 1)]);
              expect(probe.reads).toHaveLength(empty ? 0 : 1);
              expect(probe.events.filter((path) => path.endsWith('/_search/template'))).toEqual([
                `/${subjectIndexName(prefix, 1)}/_search/template`,
              ]);
            }
          }
        }
      for (const operation of operations)
        for (const control of mappingControls(subjectIndexName(prefix, 1))) {
          const capture = captureMetadata(engine, 'mapping', control);
          const probe = observed({ client: capture.client });
          await discoveryProblem(invoke(probe, operation));
          expect(probe.reads).toEqual([]);
          expect(probe.consumers).toEqual([]);
          expect(probe.events.filter((path) => path.endsWith('/_search/template'))).toEqual([]);
        }
    });
  }, 180_000);

  test('discovery refuses missing and unsupported native sort formats before engine or Source work', async () => {
    await atFirst(async () => {
      const index = subjectIndexName(prefix, 1);
      for (const operation of operations)
        for (const format of [undefined, 0, 2]) {
          const capture = captureMetadata(engine, 'mapping', {
            name: `unsupported ${format}`,
            corrupt(receipt) {
              const body = receipt.body as Record<string, { mappings: { _meta?: unknown } }>;
              body[index]!.mappings._meta = format === undefined ? {} : { name_sort_format: format };
            },
          });
          const probe = observed({ client: capture.client });
          await discoveryProblem(invoke(probe, operation));
          expect(probe.reads).toEqual([]);
          expect(probe.consumers).toEqual([]);
          expect(probe.events.filter((path) => path.endsWith('/_search/template'))).toEqual([]);
        }
    });
  });

  test('discovery native plan generation is validated before I/O and survives empty native responses', async () => {
    for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const probe = transport();
      await expect(
        Promise.resolve().then(() =>
          suggestSubjects(probe.search, prefix, {
            text: 'custody',
            size: 2,
            generation,
          }),
        ),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        countFacets(probe.search, prefix, {
          facets: [{ property, size: 1 }],
          sample: 10,
          generation,
        }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(probe.calls).toEqual([]);
    }
    for (const generation of [1, 2]) {
      const probe = transport();
      expect(await suggestSubjects(probe.search, prefix, { text: 'absentcustody', size: 2, generation })).toEqual([]);
      const facets = await countFacets(probe.search, prefix, {
        query: { match: { search_text: 'absentcustody' } },
        facets: [{ property, size: 1 }],
        sample: 10,
        generation,
      });
      expect(facets.facets[0]!.values).toEqual([]);
      expect(probe.calls.map(({ path }) => path)).toEqual(
        Array(2).fill(`/${subjectIndexName(prefix, generation)}/_search/template`),
      );
    }
  });

  test('native discovery work stays fixed with 64, 512 and 4096 unrelated documents and history', async () => {
    const unrelated: IndexedSubject[] = [];
    const metadataBounds = new Map<Operation, { path: string; bytes: number }[]>();
    let history = 0;
    for (const [round, scale] of [64, 512, 4096].entries()) {
      while (unrelated.length < scale)
        unrelated.push({
          ...books[1]!,
          id: newId(160),
          labels: [{ language: 'en', value: 'Unrelated history' }],
          statements: [],
        });
      const result = await engine.bulk<{ errors: boolean }>(
        bulkLines(
          subjectIndexName(prefix, 2),
          documentActions(
            {
              partition: 10,
              position: BigInt(round + 1),
              subjects: unrelated,
            },
            unrelated.map(({ id }) => id),
          ),
        ),
        { query: { refresh: 'wait_for' } },
      );
      expect(result.errors).toBe(false);
      // Actual retained outbox history grows on the same managed database.
      await metadataPool.query(
        `WITH head AS (
        UPDATE core.partition SET position = position + $1 WHERE partition_no = 902 RETURNING epoch, position
      ) INSERT INTO core.outbox
        (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
        SELECT 902, head.position - n + 1, 0, 1, head.epoch, gen_random_uuid(),
          'com.rezics.subject.created.v1', $2, '{}'::jsonb, '2026-02-01T00:00:00Z'::timestamptz
        FROM head, generate_series(1, $1::integer) AS n`,
        [scale - history, books[1]!.id],
      );
      history = scale;
      const { rows } = await metadataPool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM core.outbox WHERE partition_no = 902 AND subject = $1',
        [books[1]!.id],
      );
      expect(rows[0]!.count).toBe(scale);
      for (const operation of operations) {
        const probe = observed();
        await invoke(probe, operation);
        assertWork(probe, 2, false, operation);
        const metadata = probe.receipts.filter(
          ({ path }) => path.startsWith('/_resolve/index/') || path.endsWith('/_mapping'),
        );
        expect(metadata).toHaveLength(3);
        const charge = metadata.map(({ path, bytes }) => ({ path, bytes }));
        const previous = metadataBounds.get(operation);
        if (previous) expect(charge).toEqual(previous);
        else metadataBounds.set(operation, charge);
        expect(probe.receipts.filter(({ path }) => path.endsWith('/_search/template'))).toHaveLength(1);
        expect(probe.reads.flatMap(({ ids }) => ids)).toHaveLength(1);
        console.info(
          'native discovery cost',
          JSON.stringify({
            operation,
            scale,
            metadata: charge,
            paths: probe.receipts.map(({ path }) => path),
            native: probe.receipts.filter(({ path }) => path.endsWith('/_search/template')),
            reads: probe.reads,
            consumers: probe.consumers,
          }),
        );
      }
    }
  }, 120_000);
});
