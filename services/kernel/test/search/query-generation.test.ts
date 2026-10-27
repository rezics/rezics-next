import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    async request<T>(method, path, body, options) {
      const call: (typeof calls)[number] = { method, path, body };
      calls.push(call);
      const response = await engine.request<T>(method, path, body, options);
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
  try {
    await read({ ...plan('name'), generation: 1 }, 1, subjectIndexName(prefix, 1));
    await switchAlias(2, 1);
    await read(plan('name'), 1, alias);
    await read({ ...plan('name'), generation: 2 }, 2, subjectIndexName(prefix, 2));
  } finally {
    // The first assertion may fail before the switch on an implementation that ignores generation.
    await engine.request('POST', '/_aliases', {
      actions: [
        { remove: { index: subjectIndexName(prefix, 1), alias, must_exist: false } },
        { add: { index: subjectIndexName(prefix, 2), alias } },
      ],
    });
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
