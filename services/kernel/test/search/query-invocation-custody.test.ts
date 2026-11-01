import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  countFacets,
  FACET_TEMPLATE,
  HIT_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjectHits,
  searchSubjects,
  SUGGEST_TEMPLATE,
  suggestSubjects,
  type SearchPlan,
} from '../../src/search/query.ts';
import { searchRatingSubjectHits, searchRatingSubjects, type RatingQueryPlan } from '../../src/search/rating-query.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const native = createOpenSearch(url);
const prefix = `query-custody-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const property = 'schema:author';
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;

// The same document/native template path as the payload and rating fixtures. No completion
// receipts are supplied by this campaign: every admitted reply comes from the real node.
beforeAll(async () => {
  await createSubjectIndex(native, prefix, 1);
  for (let n = 1; n <= 4; n++) {
    const subject: IndexedSubject = {
      id: id(n),
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 3,
      labels: [{ language: 'en', value: `Kokoro ${n}` }],
      aliases: [],
      descriptions: [],
      statements: [{ property, value: id(1), facet: { kind: 'item' } }],
      relationFacetOverflow: n === 1 || n === 3 ? [property] : [],
    };
    const actions = documentActions({ partition: 10, position: 1n, subjects: [subject] }, [subject.id]);
    for (const action of actions) {
      if (action.op !== 'index') throw new Error('Expected a visible subject');
      // Controlled native published scores, as in rating-query.test.ts. The stale score
      // belongs to the unscored complement; zero remains a scored result.
      if (n !== 3)
        Object.assign(action.document, {
          rating_score: n === 1 ? 8 : n === 2 ? 0 : 10,
          rating_prior_epoch: n === 4 ? 6 : 7,
        });
      if (n === 4) action.document.name_sort = null;
    }
    expect(
      await native.bulk<{ errors: boolean }>(bulkLines(index, actions), { query: { refresh: 'wait_for' } }),
    ).toMatchObject({ errors: false });
  }
  await native.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  await installTemplates(native, prefix);
}, 120_000);

afterAll(async () => {
  await native.request('DELETE', `/${index}`);
  for (const template of [
    SEARCH_TEMPLATE,
    HIT_TEMPLATE,
    SUGGEST_TEMPLATE,
    'subjects-suggest-v2',
    FACET_TEMPLATE,
    'subjects-scope-hits-v1',
  ])
    await native.request('DELETE', `/_scripts/${prefix}${template}`);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Body = Record<string, unknown>;
type Call = {
  path: string;
  sent: unknown;
  request: unknown;
  options: Parameters<OpenSearch['request']>[3];
  reply: Body;
  release(): void;
};

function heldNative() {
  const calls: Call[] = [];
  const ready: Call[] = [];
  let waiting = deferred<Call>();
  const client: OpenSearch = {
    bulk: native.bulk,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const sent = structuredClone(args[2]);
      const response = await native.request<T>(...args);
      if (args[1].endsWith('/_search/template')) {
        expect(response.body).toMatchObject({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 } });
      }
      const gate = deferred<void>();
      const call: Call = {
        path: args[1],
        sent,
        request: args[2],
        options: args[3],
        reply: response.body as Body,
        release: () => gate.resolve(),
      };
      calls.push(call);
      ready.push(call);
      waiting.resolve(call);
      await gate.promise;
      return response;
    },
  };
  return {
    client,
    calls,
    async next() {
      if (ready.length === 0) await waiting.promise;
      const call = ready.shift()!;
      waiting = deferred<Call>();
      return call;
    },
  };
}

// Mutate retained containers too, so replacing a parent's property cannot hide an escaped tuple.
function poison(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) poison(item);
    value.splice(0, value.length, 'transport mutation');
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      poison(item);
      if (item === null || typeof item !== 'object') (value as Body)[key] = 'transport mutation';
    }
  }
}

function definition(empty = false) {
  return {
    query: { bool: { must: [{ match: { search_text: { query: 'kokoro', _name: 'custody-query' } } }] } },
    filter: {
      bool: { filter: [{ terms: { type: [empty ? 'schema:Recipe' : 'schema:Book'], _name: 'custody-filter' } }] },
    },
    boost: 'Kokoro 1',
    overflowProperties: [property],
  };
}

function mutateDefinition(input: ReturnType<typeof definition>) {
  input.query.bool.must[0]!.match.search_text.query = 'caller mutation';
  input.query.bool.must.push({ match: { search_text: { query: 'unfindable', _name: 'changed' } } });
  input.filter.bool.filter[0]!.terms.type.splice(0, 1, 'schema:Recipe');
  input.overflowProperties.splice(0, 1, 'changed-property');
  input.boost = 'changed boost';
}

function params(call: Call): Body {
  return (call.sent as { params: Body }).params;
}

for (const counted of [true, false]) {
  for (const empty of [false, true]) {
    test(`query invocation custody: ordinary counted=${counted} empty=${empty} concurrent requests and owned results`, async () => {
      const settlements: number[] = [];
      const work = {
        bytes: 4 * 1024 * 1024,
        deadline: Date.now() + 120_000,
        settle: (bytes: number) => {
          settlements.push(bytes);
        },
      };
      const original = {
        ...definition(empty),
        sort: 'name' as SearchPlan['sort'],
        size: 4,
        generation: 1,
        after: ['', id(0)] as (string | number | null)[],
      };
      const admitted = structuredClone(original);
      const input = { ...original, work };
      const invoke = counted ? searchSubjects : searchSubjectHits;
      const healthy = await invoke(native, prefix, admitted);
      const first = heldNative();
      const second = heldNative();
      const a = invoke(first.client, prefix, input);
      const callA = await first.next();
      poison(callA.request);
      expect({ ...input, work: undefined }).toEqual({ ...admitted, work: undefined });
      const b = invoke(second.client, prefix, input);
      const callB = await second.next();
      expect(callB.sent).toEqual(callA.sent);
      mutateDefinition(input);
      input.after.splice(0, 2, null, id(4));
      input.generation = 2;
      input.size = 1;
      input.sort = 'id';
      poison(callB.request);
      callB.release();
      const resultB = await b;
      callA.release();
      const resultA = await a;
      expect(resultA).toEqual(healthy);
      expect(resultB).toEqual(healthy);
      expect(resultA.hits).toHaveLength(empty ? 0 : 4);
      if (!empty) {
        expect(resultA.hits.at(-1)!.sort).toEqual([null, id(4)]);
        expect(resultA.hits[0]!.matched).toContain('custody-query');
      }
      for (const observer of [first, second]) {
        expect(observer.calls).toHaveLength(1);
        const call = observer.calls[0]!;
        expect(call.path).toBe(`/${index}/_search/template`);
        expect((call.sent as { id: string }).id).toBe(`${prefix}${counted ? SEARCH_TEMPLATE : HIT_TEMPLATE}`);
        expect(call.options!.work).toBe(work);
        expect(call.options!.query).toEqual({ allow_partial_search_results: false });
        if (!counted) expect(call.reply.hits).not.toHaveProperty('total');
        poison(call.reply);
      }
      expect(resultA).toEqual(healthy);
      expect(resultB).toEqual(healthy);
      resultA.hits[0]?.sort.push('consumer mutation');
      expect(resultB).toEqual(healthy);
      expect(settlements.length).toBeGreaterThan(0);
      expect(input.generation).toBe(2);
    });
  }
}

for (const empty of [false, true]) {
  test(`query invocation custody: suggestion empty=${empty} retains admission and owns its hits`, async () => {
    const input = { text: empty ? 'unfindablecustodytoken' : 'Koko', size: 4, generation: 1 };
    const healthy = await suggestSubjects(native, prefix, { ...input });
    const observer = heldNative();
    const pending = suggestSubjects(observer.client, prefix, input);
    const call = await observer.next();
    poison(call.request);
    input.text = 'changed';
    input.size = 1;
    input.generation = 2;
    call.release();
    const result = await pending;
    expect(result).toEqual(healthy);
    expect(result).toHaveLength(empty ? 0 : 4);
    poison(call.reply);
    expect(result).toEqual(healthy);
    expect(observer.calls).toHaveLength(1);
    expect(call.path).toBe(`/${index}/_search/template`);
    expect(params(call).size).toBe(4);
  });
}

for (const definite of [false, true]) {
  for (const empty of [false, true]) {
    test(`query invocation custody: facets definite=${definite} empty=${empty} retain properties sizes sample and overflow`, async () => {
      const input = {
        ...definition(empty),
        generation: 1,
        overflowProperties: definite ? [property] : [],
        facets: [
          { property: 'type', size: 1 },
          { property, size: 1 },
        ],
        sample: 10,
      };
      const admitted = structuredClone(input);
      const healthy = await countFacets(native, prefix, admitted);
      const observer = heldNative();
      const pending = countFacets(observer.client, prefix, input);
      const call = await observer.next();
      poison(call.request);
      expect(input).toEqual(admitted);
      mutateDefinition(input);
      input.facets[0]!.property = property;
      input.facets[1]!.property = 'type';
      input.facets[0]!.size = 0;
      input.facets.push({ property: 'changed', size: 1 });
      input.sample = 0;
      input.generation = 2;
      call.release();
      const result = await pending;
      expect(result).toEqual(healthy);
      expect(result.facets.map((facet) => facet.property)).toEqual(['type', property]);
      expect(result.total).toEqual({
        value: empty ? 0 : definite ? 2 : 4,
        relation: !empty && definite ? 'lower_bound' : 'exact',
      });
      poison(call.reply);
      expect(result).toEqual(healthy);
      expect(observer.calls).toHaveLength(1);
      expect(call.path).toBe(`/${index}/_search/template`);
    });
  }
}

const ratingSurfaces = [
  {
    name: 'direct counted',
    counted: true,
    invoke: (client: OpenSearch, input: RatingQueryPlan) =>
      searchRatingSubjects(client, prefix, input, SEARCH_TEMPLATE),
  },
  {
    name: 'direct hits',
    counted: false,
    invoke: (client: OpenSearch, input: RatingQueryPlan) => searchRatingSubjectHits(client, prefix, input),
  },
  {
    name: 'ordinary counted rating',
    counted: true,
    invoke: (client: OpenSearch, input: RatingQueryPlan) =>
      searchSubjects(client, prefix, { ...input, sort: 'rating' }),
  },
  {
    name: 'ordinary rating hits',
    counted: false,
    invoke: (client: OpenSearch, input: RatingQueryPlan) =>
      searchSubjectHits(client, prefix, { ...input, sort: 'rating' }),
  },
];

for (const surface of ratingSurfaces) {
  for (const scenario of ['mixed', 'full', 'empty', 'null epoch', 'unscored after'] as const) {
    test(`query invocation custody: ${surface.name} ${scenario} pins alias epoch and both phase definitions`, async () => {
      const input: ReturnType<typeof definition> &
        Omit<RatingQueryPlan, 'after'> & {
          after: (string | number | null)[];
        } = {
        ...definition(scenario === 'empty'),
        size: scenario === 'full' ? 1 : 4,
        rating: {
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
          priorEpoch: scenario === 'null epoch' ? null : 7,
        },
        ratingPhase:
          scenario === 'null epoch' || scenario === 'unscored after' ? ('unscored' as const) : ('scored' as const),
        after: scenario === 'null epoch' || scenario === 'unscored after' ? ['', id(0)] : [9, '', id(0)],
      };
      const admitted = structuredClone(input);
      const healthy = await surface.invoke(native, admitted);
      const observer = heldNative();
      const pending = surface.invoke(observer.client, input);
      const alias = await observer.next();
      expect(alias.path).toBe(`/_resolve/index/${prefix}subjects*`);
      // Two independent invocations share all of the caller's nested objects while alias
      // resolution is delayed. Subsequent caller and transport writes must affect neither.
      const concurrent = scenario === 'mixed' ? heldNative() : undefined;
      const otherPending = concurrent ? surface.invoke(concurrent.client, input) : undefined;
      const otherAlias = concurrent ? await concurrent.next() : undefined;
      mutateDefinition(input);
      input.after.splice(0, input.after.length, 'caller mutation');
      input.size = 2;
      input.generation = 2;
      input.rating.priorEpoch = 99;
      input.rating.questionId = id(99);
      input.rating.populationId = id(98);
      input.ratingPhase = 'unscored';
      alias.release();
      otherAlias?.release();
      const phaseA = await observer.next();
      const otherA = concurrent ? await concurrent.next() : undefined;
      const aParams = params(phaseA);
      const firstCountOnly =
        surface.counted && admitted.ratingPhase === 'unscored' && admitted.rating.priorEpoch !== null;
      expect(aParams.query).toEqual(admitted.query);
      expect(aParams.after).toEqual(firstCountOnly ? undefined : admitted.after);
      expect(aParams.boost).toBe(JSON.stringify(admitted.boost));
      expect(aParams.overflow_properties).toEqual([property]);
      expect(aParams.size).toBe(firstCountOnly ? 0 : admitted.size);
      expect(JSON.stringify(aParams.filter)).toContain(admitted.filter.bool.filter[0]!.terms.type[0]!);
      if (admitted.rating.priorEpoch !== null)
        expect(JSON.stringify(aParams.filter)).toContain('"rating_prior_epoch":7');
      if (otherA) expect(otherA.sent).toEqual(phaseA.sent);
      poison(phaseA.request);
      if (otherA) poison(otherA.request);
      // Mutate the same original nested record again between native phase requests.
      input.rating.priorEpoch = 123;
      input.overflowProperties.length = 0;
      phaseA.release();
      otherA?.release();
      const hasSecond =
        admitted.rating.priorEpoch !== null &&
        (surface.counted || (admitted.ratingPhase === 'scored' && scenario !== 'full'));
      if (hasSecond) {
        const phaseB = await observer.next();
        const otherB = concurrent ? await concurrent.next() : undefined;
        const bParams = params(phaseB);
        expect(bParams.query).toEqual(admitted.query);
        expect(bParams.boost).toBe(JSON.stringify(admitted.boost));
        expect(bParams.overflow_properties).toEqual([property]);
        const filters = (bParams.filter as { bool: { filter: unknown[] } }).bool.filter;
        expect(filters[0]).toEqual(admitted.filter);
        if (admitted.ratingPhase === 'scored') {
          expect(filters[1]).toEqual({
            bool: {
              must_not: [
                { bool: { filter: [{ term: { rating_prior_epoch: 7 } }, { exists: { field: 'rating_score' } }] } },
              ],
            },
          });
          expect(bParams.has_after).toBe(false);
          expect(bParams.size).toBe(scenario === 'full' ? 0 : scenario === 'empty' ? 4 : 2);
        } else {
          expect(bParams.after).toEqual(admitted.after);
        }
        if (otherB) expect(otherB.sent).toEqual(phaseB.sent);
        // Phase A's already admitted results must remain owned while phase B awaits I/O.
        poison(phaseA.reply);
        if (otherA) poison(otherA.reply);
        poison(phaseB.request);
        if (otherB) poison(otherB.request);
        phaseB.release();
        otherB?.release();
      }
      const result = await pending;
      const otherResult = otherPending ? await otherPending : undefined;
      expect(result).toEqual(healthy);
      if (otherResult) expect(otherResult).toEqual(healthy);
      expect(result.generation).toBe(1);
      expect(result.hits).toHaveLength(
        scenario === 'empty' ? 0 : scenario === 'full' ? 1 : scenario === 'unscored after' ? 2 : 4,
      );
      if (surface.counted)
        expect(result).toHaveProperty('total', { value: scenario === 'empty' ? 0 : 4, relation: 'exact' });
      else expect(result).not.toHaveProperty('total');
      for (const recording of [observer, ...(concurrent ? [concurrent] : [])]) {
        expect(recording.calls).toHaveLength(hasSecond ? 3 : 2);
        for (const call of recording.calls.slice(1)) {
          expect(call.path).toBe(`/${index}/_search/template`);
          expect((call.sent as { id: string }).id).toBe(`${prefix}${surface.counted ? SEARCH_TEMPLATE : HIT_TEMPLATE}`);
          if (!surface.counted) expect(call.reply.hits).not.toHaveProperty('total');
          poison(call.reply);
        }
      }
      expect(result).toEqual(healthy);
      if (otherResult) {
        result.hits[0]!.matched.push('consumer mutation');
        expect(otherResult).toEqual(healthy);
      }
    });
  }
}

for (const surface of ratingSurfaces) {
  test(`query invocation custody: ${surface.name} still rejects a malformed real native tuple without another request`, async () => {
    const input: RatingQueryPlan = {
      ...definition(),
      generation: 1,
      size: 1,
      rating: { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 7 },
    };
    const observer = heldNative();
    const pending = surface.invoke(observer.client, input);
    const rejected = expect(pending).rejects.toBeInstanceOf(SearchUnavailableError);
    const call = await observer.next();
    const hit = (call.reply.hits as { hits: { sort: unknown[] }[] }).hits[0]!;
    hit.sort.length = 0;
    input.size = 200;
    call.release();
    await rejected;
    expect(observer.calls).toHaveLength(1);
  });
}

for (const operation of ['counted', 'hits', 'suggest'] as const) {
  test(`query invocation custody: ${operation} caller mutation cannot authorize a foreign generation reply`, async () => {
    const input = { ...definition(), sort: 'id' as const, text: 'Koko', generation: 1, size: 4 };
    const observer = heldNative();
    const pending =
      operation === 'counted'
        ? searchSubjects(observer.client, prefix, input)
        : operation === 'hits'
          ? searchSubjectHits(observer.client, prefix, input)
          : suggestSubjects(observer.client, prefix, input);
    const rejected = expect(pending).rejects.toBeInstanceOf(SearchUnavailableError);
    const call = await observer.next();
    input.generation = 2;
    const hits = (call.reply.hits as { hits: { _index: string }[] }).hits;
    expect(hits).toHaveLength(4);
    // Change only payload identity in a genuine complete reply, as in query-payload.test.ts.
    for (const hit of hits) hit._index = subjectIndexName(prefix, 2);
    call.release();
    await rejected;
    expect(observer.calls).toHaveLength(1);
    expect(call.path).toBe(`/${index}/_search/template`);
  });
}
