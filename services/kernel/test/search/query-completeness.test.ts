import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import {
  createOpenSearch,
  OpenSearchError,
  SearchUnavailableError,
  type OpenSearch,
} from '../../src/search/opensearch.ts';
import {
  countFacets,
  FACET_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  suggestSubjects,
} from '../../src/search/query.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const native = createOpenSearch(url);
const prefix = `completion-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const missing = `missing-${crypto.randomUUID().slice(0, 8)}-`;
const id = '018f0000-0000-7000-8000-00a000000001';
const subject: IndexedSubject = {
  id,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: 'Kokoro' }],
  aliases: [],
  descriptions: [],
  statements: [],
};
const query = (empty: boolean) => ({
  match: { search_text: { query: empty ? 'unfindablecompletiontoken' : 'kokoro', operator: 'and', _name: 't0' } },
});

type Completion = {
  timed_out?: unknown;
  terminated_early?: unknown;
  _shards?: unknown;
};
type RawResponse = Completion & {
  hits: {
    hits: {
      _id: string;
      _index: string;
      _source: { partition: number; security_revision: number };
      sort?: (string | number | null)[];
      matched_queries?: string[];
    }[];
    total: { value: number; relation: string };
  };
  aggregations?: unknown;
};
type Call = {
  method: string;
  path: string;
  body: unknown;
  options: Parameters<OpenSearch['request']>[3];
  response?: RawResponse;
  error?: unknown;
};

// Every business result comes from the native node. Only completion metadata on its response is changed.
function observe(change?: (body: Completion) => void) {
  const calls: Call[] = [];
  const client: OpenSearch = {
    bulk: native.bulk,
    async request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      const call: Call = { method, path, body: structuredClone(body), options: structuredClone(options) };
      calls.push(call);
      try {
        const response = await native.request<T>(method, path, body, options);
        call.response = structuredClone(response.body) as RawResponse;
        if (!change) return response;
        const changed = structuredClone(response.body) as T & Completion;
        change(changed);
        // The injection must preserve all native hits, totals, aggregations, sort values and clause names.
        const payload = (value: T) => {
          const { timed_out: _timeout, terminated_early: _early, _shards: _shards, ...rest } = value as T & Completion;
          return rest;
        };
        expect(payload(changed)).toEqual(payload(response.body));
        return { ...response, body: changed };
      } catch (error) {
        call.error = error;
        throw error;
      }
    },
  };
  return { client, calls };
}

beforeAll(async () => {
  await createSubjectIndex(native, prefix, 1);
  const result = await native.bulk<{ errors: boolean }>(
    bulkLines(index, documentActions({ partition: 10, position: 1n, subjects: [subject] }, [id])),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
  await native.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  await installTemplates(native, prefix);
}, 120_000);

afterAll(async () => {
  await native.request('DELETE', `/${index}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
    await native.request('DELETE', `/_scripts/${prefix}${name}`);
  }
});

const faults: { name: string; change: (body: Completion) => void }[] = [
  {
    name: 'timeout',
    change: (body) => {
      body.timed_out = true;
    },
  },
  {
    name: 'failed shard',
    change: (body) => {
      const shards = body._shards as Record<string, number>;
      body._shards = { ...shards, successful: shards.successful! - 1, failed: 1 };
    },
  },
  {
    name: 'early termination',
    change: (body) => {
      body.terminated_early = true;
    },
  },
  {
    name: 'missing timeout',
    change: (body) => {
      delete body.timed_out;
    },
  },
  {
    name: 'malformed timeout',
    change: (body) => {
      body.timed_out = 'false';
    },
  },
  {
    name: 'malformed early termination',
    change: (body) => {
      body.terminated_early = 'false';
    },
  },
  {
    name: 'missing shards',
    change: (body) => {
      delete body._shards;
    },
  },
  {
    name: 'null shards',
    change: (body) => {
      body._shards = null;
    },
  },
  ...['total', 'successful', 'failed'].flatMap((field) => [
    {
      name: `missing shard ${field}`,
      change: (body: Completion) => {
        delete (body._shards as Record<string, unknown>)[field];
      },
    },
    {
      name: `malformed shard ${field}`,
      change: (body: Completion) => {
        (body._shards as Record<string, unknown>)[field] = '0';
      },
    },
    {
      name: `negative shard ${field}`,
      change: (body: Completion) => {
        (body._shards as Record<string, unknown>)[field] = -1;
      },
    },
  ]),
  {
    name: 'incomplete successful shards without a reported failure',
    change: (body) => {
      (body._shards as Record<string, number>).successful! -= 1;
    },
  },
];

type Operation = {
  name: string;
  template: string;
  run: (client: OpenSearch, target: string, empty: boolean) => Promise<unknown>;
  verify: (output: unknown, empty: boolean, raw: RawResponse) => void;
};
const operations: Operation[] = [
  {
    name: 'ordinary native query requests disable partial results and reject timeout shard and early termination responses',
    template: SEARCH_TEMPLATE,
    run: (client, target, empty) =>
      searchSubjects(client, target, {
        query: query(empty),
        boost: 'kokoro',
        sort: 'relevance',
        size: 2,
      }),
    verify: (output, empty, raw) => {
      expect(output).toEqual({
        hits: raw.hits.hits.map((hit) => ({
          id: hit._id,
          index: hit._index,
          partition: hit._source.partition,
          securityRevision: hit._source.security_revision,
          matched: hit.matched_queries ?? [],
          sort: hit.sort,
        })),
        total: { value: empty ? 0 : 1, relation: 'exact' },
      });
      expect(raw.hits.hits.map((hit) => hit._id)).toEqual(empty ? [] : [id]);
      if (!empty) {
        expect(raw.hits.hits[0]!.matched_queries).toEqual(['t0']);
        expect(raw.hits.hits[0]!.sort).toHaveLength(2);
      }
    },
  },
  {
    name: 'native suggestions reject incomplete responses even without a cursor or total output',
    template: SUGGEST_TEMPLATE,
    run: (client, target, empty) =>
      suggestSubjects(client, target, {
        text: empty ? 'unfindablecompletiontoken' : 'Koko',
        size: 2,
      }),
    verify: (output, empty) => {
      expect(output).toEqual(empty ? [] : [{ id, index, partition: 10, securityRevision: 1 }]);
    },
  },
  {
    name: 'native facet counts reject incomplete responses even without requested hits',
    template: FACET_TEMPLATE,
    run: (client, target, empty) =>
      countFacets(client, target, {
        query: query(empty),
        facets: [{ property: 'type', size: 2 }],
        sample: 10,
      }),
    verify: (output, empty, raw) => {
      expect(raw.hits.hits).toEqual([]);
      expect(output).toEqual({
        total: { value: empty ? 0 : 1, relation: 'exact' },
        facets: [{ property: 'type', relation: 'exact', values: empty ? [] : [{ value: 'schema:Book', count: 1 }] }],
      });
    },
  },
];

for (const operation of operations) {
  test(
    operation.name,
    async () => {
      const admissions: { empty: boolean; fault: string; rejected: boolean; unavailable: boolean }[] = [];
      const requests: Call[] = [];
      for (const empty of [false, true]) {
        // Establish native success and real zero-hit exhaustion before any negative response injection.
        const baseline = observe();
        const output = await operation.run(baseline.client, prefix, empty);
        expect(baseline.calls).toHaveLength(1);
        const raw = baseline.calls[0]!.response!;
        expect(raw.timed_out).toBe(false);
        expect(raw._shards).toMatchObject({ total: 1, successful: 1, failed: 0 });
        operation.verify(output, empty, raw);
        requests.push(...baseline.calls);

        // Explicit false is also complete; absence of terminated_early in native responses is legal.
        const complete = observe((body) => {
          body.terminated_early = false;
        });
        expect(await operation.run(complete.client, prefix, empty)).toEqual(output);
        requests.push(...complete.calls);
        for (const fault of faults) {
          const injected = observe(fault.change);
          const outcome = await operation.run(injected.client, prefix, empty).then(
            () => ({ rejected: false, unavailable: false }),
            (error: unknown) => ({ rejected: true, unavailable: error instanceof SearchUnavailableError }),
          );
          expect(injected.calls).toHaveLength(1);
          expect(injected.calls[0]!.response).toBeDefined();
          admissions.push({ empty, fault: fault.name, ...outcome });
          requests.push(...injected.calls);
        }
      }
      for (const call of requests) {
        expect(call.method).toBe('POST');
        expect(call.path).toBe(`/${subjectAlias(prefix)}/_search/template`);
        expect(call.body).toMatchObject({ id: `${prefix}${operation.template}` });
      }
      // Report both boundary defects after exercising every protocol case.
      expect({
        incompleteResponsesAccepted: admissions.filter((result) => !result.rejected || !result.unavailable),
        requestsAllowingPartialResults: requests
          .filter((call) => call.options?.query?.allow_partial_search_results !== false)
          .map((call) => ({ path: call.path, options: call.options })),
      }).toEqual({ incompleteResponsesAccepted: [], requestsAllowingPartialResults: [] });
    },
    120_000,
  );

  test(`${operation.template} propagates the actual native client failure`, async () => {
    const observed = observe();
    const error = await operation.run(observed.client, missing, false).catch((error: unknown) => error);
    expect(observed.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(OpenSearchError);
    expect(error).toBe(observed.calls[0]!.error);
    expect(error).toMatchObject({ status: 404 });
  });
}
