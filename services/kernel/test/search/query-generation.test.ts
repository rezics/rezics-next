import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError, problemResponse } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import {
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
