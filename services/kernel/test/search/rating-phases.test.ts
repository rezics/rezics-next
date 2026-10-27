import { afterAll, expect, test } from 'bun:test';
import { subjectAlias, subjectIndexDefinition, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { installTemplates, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const engine = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const physical = (generation: number) => subjectIndexName(prefix, generation);
const id = (n: number) => `00000000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const rating = {
  questionId: '00000000-0000-7000-8000-000000000001',
  populationId: '00000000-0000-8000-8000-000000000000',
  priorEpoch: 7 as number | null,
};
type Tuple = (string | number | null)[];
type Phase = 'scored' | 'unscored';
// The additive contract may land independently. Resolve its runtime export only after the native baseline;
// an absent module must be a regression assertion, not a static import/setup failure.
type Plan = {
  rating: typeof rating;
  size: number;
  generation?: number;
  ratingPhase?: Phase;
  after?: Tuple;
  query?: Record<string, unknown>;
  filter?: Record<string, unknown>;
};
type Hit = {
  id: string;
  index: string;
  partition: number;
  securityRevision: number;
  matched: string[];
  sort: Tuple;
  ratingPhase?: Phase;
};
type Result = {
  hits: Hit[];
  generation?: number;
  total: { value: number; relation: 'exact' | 'lower_bound' };
};
type Query = (client: OpenSearch, prefix: string, plan: Plan, template: string) => Promise<Result>;
type NativeHit = { _id: string; _index: string; sort: Tuple };
type NativeResponse = {
  timed_out: boolean;
  terminated_early?: boolean;
  _shards: { failed: number };
  hits: { hits: NativeHit[]; total: { value: number; relation: string } };
};
type Recorded = { path: string; body: Record<string, unknown>; response: NativeResponse };
const common = { match: { search_text: { query: 'needle', operator: 'and', _name: 'text' } } };
const filter = { term: { type: { value: 'schema:Book', _name: 'book' } } };
const predicate = { bool: { filter: [{ term: { rating_prior_epoch: 7 } }, { exists: { field: 'rating_score' } }] } };
const nameSort = [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }];
const scoredSort = [{ rating_score: 'desc' }, ...nameSort];
// Controlled scalar engine-order projections only. Producer validation of arrays, score range and publication
// provenance belongs to the source/document tests; exists is deliberately not treated as a cardinality validator.
const rows = [
  { n: 1, name: 'Zebra', score: 8, epoch: 7 },
  { n: 2, name: 'Ａlpha', score: 8, epoch: 7 },
  { n: 3, name: 'alpha', score: 8, epoch: 7 },
  { n: 4, name: null, score: 8, epoch: 7 },
  { n: 5, name: 'Zero', score: 0, epoch: 7 },
  { n: 6, name: null, score: 0, epoch: 7 },
  { n: 7, name: 'Aardvark', score: 10, epoch: 6 },
  { n: 8, name: 'Beta', score: 9, epoch: 5 },
  { n: 9, name: 'alpha', score: null, epoch: 7 },
  { n: 10, name: 'alpha', epoch: 7 },
  { n: 11, name: 'Delta', score: 10, epoch: null },
  { n: 12, name: 'Echo', score: 10 },
  { n: 13, name: 'Gamma', score: null, epoch: null },
  { n: 14, name: null },
  { n: 15, name: 'Excluded type', score: 10, epoch: 7, type: 'schema:Recipe' },
  { n: 16, name: 'Excluded text', score: 10, epoch: 7, text: 'other' },
];
const a = [2, 3, 1, 4, 5, 6].map(id);
const b = [7, 9, 10, 8, 11, 12, 13, 14].map(id);
const created: number[] = [];
async function alias(generation: number, previous?: number) {
  await engine.request('POST', '/_aliases', {
    actions: [
      ...(previous ? [{ remove: { index: physical(previous), alias: subjectAlias(prefix) } }] : []),
      { add: { index: physical(generation), alias: subjectAlias(prefix) } },
    ],
  });
}
afterAll(async () => {
  for (const generation of created) await engine.request('DELETE', `/${physical(generation)}`).catch(() => undefined);
  for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, 'subjects-facets-v1'])
    await engine.request('DELETE', `/_scripts/${prefix}${template}`).catch(() => undefined);
});

function recording(afterResponse?: (response: NativeResponse, ordinal: number) => Promise<void> | void) {
  const calls: Recorded[] = [];
  const client: OpenSearch = {
    bulk: engine.bulk,
    async request<T>(...[method, path, body, options]: Parameters<OpenSearch['request']>) {
      const response = await engine.request<T>(method, path, body, options);
      if (/\/_search(?:\/template)?(?:\?|$)/.test(path)) {
        const raw = response.body as NativeResponse;
        calls.push({ path, body: body as Record<string, unknown>, response: structuredClone(raw) });
        // Only negative status flags are injected. All positive hits and sort keys come from the engine.
        await afterResponse?.(raw, calls.length);
        expect(
          options?.query?.allow_partial_search_results === false ||
            options?.query?.allow_partial_search_results === 'false' ||
            path.includes('allow_partial_search_results=false'),
        ).toBe(true);
      }
      return response;
    },
  };
  return { client, calls };
}
function params(call: Recorded): Record<string, unknown> {
  return (call.body.params ?? call.body) as Record<string, unknown>;
}
function bounded(calls: Recorded[], q: number, generation = 1) {
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.length).toBeLessThanOrEqual(2);
  expect(calls.reduce((sum, call) => sum + Number(params(call).size), 0)).toBeLessThanOrEqual(q);
  expect(calls.reduce((sum, call) => sum + call.response.hits.hits.length, 0)).toBeLessThanOrEqual(q);
  for (const call of calls) {
    expect(call.path.split('/')[1]).toBe(physical(generation));
    expect(call.response.timed_out).toBe(false);
    expect(call.response._shards.failed).toBe(0);
    expect(call.body).not.toHaveProperty('script');
  }
}
function rawHits(result: Result, calls: Recorded[], epoch: number | null) {
  for (const hit of result.hits) {
    const raw = calls.flatMap((call) => call.response.hits.hits).find((entry) => entry._id === hit.id)!;
    expect(raw).toBeDefined();
    expect(hit.sort).toEqual(raw.sort);
    expect(hit.index).toBe(raw._index);
    expect(hit).toMatchObject({ partition: 10, securityRevision: 3 });
    expect(hit.matched).toContain('text');
    expect(hit.matched).toContain('book');
    expect(hit.ratingPhase).toBe(epoch !== null && a.includes(hit.id) ? 'scored' : 'unscored');
    expect(hit.sort).toHaveLength(hit.ratingPhase === 'scored' ? 3 : 2);
  }
}

test('native mixed epoch phases are exhaustive disjoint generation pinned and bounded with truthful failures and raw continuation', async () => {
  expect((await engine.request<{ version: { number: string } }>('GET', '/')).body.version.number).toMatch(/^3\.9\./);
  const definition = structuredClone(subjectIndexDefinition()) as {
    mappings: { properties: Record<string, unknown> };
  };
  Object.assign(definition.mappings.properties, {
    rating_score: { type: 'double', coerce: false, doc_values: true },
    rating_prior_epoch: { type: 'long', coerce: false, doc_values: true },
  });
  for (const generation of [1, 2]) {
    await engine.request('PUT', `/${physical(generation)}`, definition);
    created.push(generation);
  }
  const lines = rows.flatMap((row) => [
    { index: { _index: physical(1), _id: id(row.n) } },
    {
      id: id(row.n),
      partition: 10,
      security_revision: 3,
      type: row.type ?? 'schema:Book',
      names: row.text ?? 'needle',
      name_sort: row.name,
      ...('score' in row ? { rating_score: row.score } : {}),
      ...('epoch' in row ? { rating_prior_epoch: row.epoch } : {}),
    },
  ]);
  expect(await engine.bulk<{ errors: boolean }>(lines, { query: { refresh: 'wait_for' } })).toMatchObject({
    errors: false,
  });
  await alias(1);
  await installTemplates(engine, prefix);
  async function native(phase: Phase) {
    const response = await engine.request<NativeResponse>(
      'POST',
      `/${physical(1)}/_search`,
      {
        size: 40,
        query: {
          bool: {
            must: [common],
            filter: [filter, ...(phase === 'scored' ? [predicate] : [])],
            ...(phase === 'unscored' ? { must_not: [predicate] } : {}),
          },
        },
        sort: phase === 'scored' ? scoredSort : nameSort,
      },
      { query: { allow_partial_search_results: false } },
    );
    expect(response.body._shards.failed).toBe(0);
    expect(response.body.timed_out).toBe(false);
    return response.body.hits.hits;
  }
  // Establish actual ICU normalization, null sorting and the exact complement before loading unfinished code.
  const nativeA = await native('scored');
  const nativeB = await native('unscored');
  expect(nativeA.map((hit) => hit._id)).toEqual(a);
  expect(nativeB.map((hit) => hit._id)).toEqual(b);
  expect(nativeA[0]!.sort).toEqual([8, 'alpha', id(2)]);
  expect(nativeA.at(-1)!.sort).toEqual([0, null, id(6)]);
  expect(nativeB.at(-1)!.sort).toEqual([null, id(14)]);
  expect(new Set([...nativeA, ...nativeB].map((hit) => hit._id)).size).toBe(14);

  const modulePath = '../../src/search/rating-query.ts';
  const implementation = (
    (await Bun.file(new URL(modulePath, import.meta.url)).exists()) ? await import(modulePath) : {}
  ) as { searchRatingSubjects?: Query };
  expect(
    implementation.searchRatingSubjects,
    'native baseline passed; missing additive searchRatingSubjects export',
  ).toBeFunction();
  const query = implementation.searchRatingSubjects!;
  const plan: Plan = { rating, query: common, filter, size: 200 };
  async function run(patch: Partial<Plan> = {}, observer = recording()) {
    const result = await query(observer.client, prefix, { ...plan, ...patch }, SEARCH_TEMPLATE);
    bounded(observer.calls, patch.size ?? plan.size, patch.generation ?? 1);
    expect(result.generation).toBe(patch.generation ?? 1);
    rawHits(result, observer.calls, (patch.rating ?? rating).priorEpoch);
    return { result, calls: observer.calls };
  }
  const whole = await run();
  expect(whole.result.hits.map((hit) => hit.id)).toEqual([...a, ...b]);
  // This is an indexed fixed-fixture observation, never a live disclosed-total promise.
  expect(whole.result.total).toEqual({ value: 14, relation: 'exact' });
  expect(whole.calls.map((call) => params(call).size)).toEqual([200, 194]);

  for (const size of [1, 3, 6, 7, 14, 200]) {
    const seen: string[] = [];
    let continuation: Partial<Plan> = {};
    for (let round = 0; round < 20; round++) {
      const { result, calls } = await run({ size, ...continuation });
      seen.push(...result.hits.map((hit) => hit.id));
      if (result.hits.length < size) break;
      const last = result.hits.at(-1)!;
      continuation = { generation: result.generation!, ratingPhase: last.ratingPhase!, after: last.sort };
      if (last.ratingPhase === 'scored') {
        const hitCalls = calls.filter((call) => Number(params(call).size) > 0);
        expect(hitCalls[0]!.response.hits.hits.length).toBe(size);
        expect(hitCalls).toHaveLength(1); // Full A never proves exhaustion, even at its exact quota.
      }
    }
    expect(seen).toEqual([...a, ...b]);
    expect(new Set(seen).size).toBe(14);
  }
  // A short response can include B lookahead. Leaving B unconsumed retains A's complete native tuple.
  const lookahead = await run({ size: 7 });
  expect(lookahead.result.hits[6]!.id).toBe(b[0]!);
  const unusedA = lookahead.result.hits[1]!;
  const resumedA = await run({ size: 7, ratingPhase: unusedA.ratingPhase!, after: unusedA.sort });
  expect(resumedA.result.hits.map((hit) => hit.id)).toEqual([...a.slice(2), ...b.slice(0, 3)]);
  const lastConsumed = lookahead.result.hits[5]!;
  const replay = await run({ size: 7, ratingPhase: lastConsumed.ratingPhase!, after: lastConsumed.sort });
  expect(replay.result.hits.map((hit) => hit.id)).toEqual(b.slice(0, 7));
  expect(params(replay.calls[0]!).after).toEqual([0, null, id(6)]);
  expect(params(replay.calls[1]!).after).toBeUndefined();
  expect(replay.calls.map((call) => call.response.hits.hits.length)).toEqual([0, 7]);

  const nullEpoch = await run({ rating: { ...rating, priorEpoch: null } });
  expect(nullEpoch.result.hits.map((hit) => hit.id)).toEqual([7, 2, 3, 9, 10, 8, 11, 12, 13, 1, 5, 4, 6, 14].map(id));
  for (const hit of nullEpoch.result.hits) {
    expect(hit.ratingPhase).toBe('unscored');
    expect(hit.sort).toHaveLength(2);
  }
  const zero = await run({ filter: { term: { id: id(99) } } });
  expect(zero.result.hits).toEqual([]);
  expect(zero.result.generation).toBe(1);

  // Both positive-hit phases remain on g1 even after a real alias switch between their requests.
  const switched = recording(async (_response, ordinal) => {
    if (ordinal === 1) await alias(2, 1);
  });
  const pinned = await run({}, switched);
  expect(pinned.result.hits.map((hit) => hit.id)).toEqual([...a, ...b]);
  expect(pinned.calls).toHaveLength(2);
  await alias(1, 2);
  // Repeat with zero hits in A: generation cannot be inferred from A's first hit.
  const emptyA = recording(async (_response, ordinal) => {
    if (ordinal === 1) await alias(2, 1);
  });
  const staleOnly = await run({ filter: { bool: { filter: [filter, { terms: { id: [id(7), id(8)] } }] } } }, emptyA);
  expect(staleOnly.result.hits.map((hit) => hit.id)).toEqual([id(7), id(8)]);
  expect(staleOnly.calls[0]!.response.hits.hits).toEqual([]);
  await alias(1, 2);
  expect((await run({ generation: 2 })).result.hits).toEqual([]);
  await engine.request('DELETE', `/${physical(2)}`);
  await expect(query(engine, prefix, { ...plan, generation: 2 }, SEARCH_TEMPLATE)).rejects.toThrow();
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await expect(query(engine, prefix, { ...plan, generation }, SEARCH_TEMPLATE)).rejects.toThrow();

  for (const negative of [
    (response: NativeResponse) => {
      response.timed_out = true;
    },
    (response: NativeResponse) => {
      response._shards.failed = 1;
    },
    (response: NativeResponse) => {
      response.terminated_early = true;
    },
  ]) {
    for (const failureAt of [1, 2]) {
      const observer = recording((response, ordinal) => {
        if (ordinal === failureAt) negative(response);
      });
      await expect(query(observer.client, prefix, plan, SEARCH_TEMPLATE)).rejects.toBeInstanceOf(
        SearchUnavailableError,
      );
      expect(observer.calls.length).toBeLessThanOrEqual(failureAt);
    }
  }
  const transport = recording(() => {
    throw new SearchUnavailableError('injected transport outage after native response');
  });
  await expect(query(transport.client, prefix, plan, SEARCH_TEMPLATE)).rejects.toBeInstanceOf(SearchUnavailableError);
}, 120_000);
