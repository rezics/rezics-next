import { HIT_TEMPLATE, searchSubjectHits, type HitResult } from '../../src/search/query.ts';
import { SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { searchRatingSubjectHits, searchRatingSubjects } from '../../src/search/rating-query.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import {
  FACET_TEMPLATE,
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  type SearchPlan,
} from '../../src/search/query.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-rating-${crypto.randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const id = (n: number) =>
  `018f0000-0000-7000-8000-${((10 + n) * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`;

function subject(n: number, name: string, type = 'schema:Book'): IndexedSubject {
  return {
    id: id(n),
    type,
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: name }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
}

// One population, with controlled published scores. Mean/count are adversarial diagnostics:
// high values on unscored rows must never become a substitute score.
const fixtures = [
  { subject: subject(1, 'Rating Zulu'), score: 0, mean: 10, count: 10_000 },
  { subject: subject(2, 'Rating Beta'), score: 8.25, mean: 1, count: 1 },
  { subject: subject(3, 'Rating Alpha'), score: 8.25, mean: 2, count: 2 },
  { subject: subject(4, 'Rating Alpha'), score: undefined, mean: 10, count: 1_000_000 },
  { subject: subject(5, 'Rating Zulu'), score: undefined, mean: 10, count: 1_000_000 },
  { subject: subject(6, 'rating alpha'), score: 8.25, mean: 9, count: 900 },
  { subject: subject(7, 'Rating Beta'), score: null, mean: 10, count: 1_000_000 },
  { subject: subject(8, 'Rating Zulu'), score: 9.75, mean: 0, count: 1 },
  { subject: subject(9, 'Rating Alpha'), score: null, mean: 10, count: 1_000_000 },
  { subject: subject(10, 'Unrelated'), score: 100, mean: 100, count: 1_000_000 },
  { subject: subject(11, 'Rating Alpha', 'schema:Recipe'), score: 100, mean: 100, count: 1_000_000 },
];
const expected = [id(8), id(3), id(6), id(2), id(1), id(4), id(9), id(7), id(5)];
const plan = {
  query: { match: { search_text: { query: 'rating', operator: 'and', _name: 't0' } } },
  filter: { terms: { type: ['schema:Book'], _name: 'f0' } },
  sort: 'rating',
  // Trusted native context, supplied internally rather than selected by a public request body.
  rating: { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 1 },
  generation: 1,
} satisfies Omit<SearchPlan, 'size'>;

async function removeOwnedResources(): Promise<void> {
  const paths = [
    index,
    ...[SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE].map((name) => `_scripts/${prefix}${name}`),
  ];
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      try {
        await search.request('DELETE', `/${path}`);
      } catch (error) {
        if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

beforeAll(async () => {
  try {
    const node = await search.request<{ version: { number: string; distribution: string } }>('GET', '/');
    expect(node.body.version.distribution).toBe('opensearch');
    expect(node.body.version.number).toMatch(/^3\./);
    await createSubjectIndex(search, prefix, 1);
    // Extend only this disposable index: production mapping/source support is a separate obligation.
    await search.request('PUT', `/${index}/_mapping`, {
      properties: {
        rating_score: { type: 'double', doc_values: true },
        rating_prior_epoch: { type: 'long', doc_values: true },
        rating_mean: { type: 'double', doc_values: true },
        rating_count: { type: 'long', doc_values: true },
      },
    });
    for (const fixture of fixtures) {
      const entry = fixture.subject;
      const actions = documentActions({ partition: subjectPartition(entry.id), position: 1n, subjects: [entry] }, [
        entry.id,
      ]);
      for (const action of actions) {
        if (action.op !== 'index') throw new Error('Expected a visible subject document');
        Object.assign(action.document, {
          ...(fixture.score === undefined ? {} : { rating_score: fixture.score }),
          ...(typeof fixture.score === 'number' ? { rating_prior_epoch: 1 } : {}),
          rating_mean: fixture.mean,
          rating_count: fixture.count,
        });
      }
      const result = await search.bulk<{ errors: boolean }>(bulkLines(index, actions), {
        query: { refresh: 'wait_for' },
      });
      expect(result.errors).toBe(false);
    }
    await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    await installTemplates(search, prefix);
  } catch (error) {
    await removeOwnedResources();
    throw error;
  }
}, 120_000);

afterAll(removeOwnedResources);

// Exact totals describe only the nine internal indexed candidates in this fixed fixture, not public totals.
// These are engine ranking and internal search_after tests, not proof of native-vote or
// public-figure privacy, population admission, current disclosure, prior updates, or signed HTTP cursors.
test('rating orders published scores descending, zero before null/missing, then normalized name and id', async () => {
  const result = await searchSubjects(search, prefix, { ...plan, size: 200 });
  expect(result.total).toEqual({ value: 9, relation: 'exact' });
  expect(result.hits.map((hit) => hit.id)).toEqual(expected);
  expect(result.hits.map((hit) => hit.sort)).toEqual([
    [9.75, 'rating zulu', id(8)],
    [8.25, 'rating alpha', id(3)],
    [8.25, 'rating alpha', id(6)],
    [8.25, 'rating beta', id(2)],
    [0, 'rating zulu', id(1)],
    ['rating alpha', id(4)],
    ['rating alpha', id(9)],
    ['rating beta', id(7)],
    ['rating zulu', id(5)],
  ]);
  expect(result.hits.map((hit) => hit.ratingPhase)).toEqual([
    'scored',
    'scored',
    'scored',
    'scored',
    'scored',
    'unscored',
    'unscored',
    'unscored',
    'unscored',
  ]);
  for (const hit of result.hits) {
    expect(hit.index).toBe(index);
    expect(hit.partition).toBe(subjectPartition(hit.id));
    expect(hit.securityRevision).toBe(1);
    expect(hit.matched).toContain('t0');
    expect(hit.matched).toContain('f0');
  }
  expect(new Set(result.hits.map((hit) => hit.partition)).size).toBeGreaterThan(1);
});

test('rating search_after page1/page2/page3 consume each id once across numeric and null boundaries', async () => {
  const page1 = await searchSubjects(search, prefix, { ...plan, size: 3 });
  const last1 = page1.hits.at(-1)!;
  if (last1.ratingPhase === undefined) throw new Error('Expected a native rating phase');
  const after1 = last1.sort;
  const page2 = await searchSubjects(search, prefix, {
    ...plan,
    size: 3,
    after: after1,
    ratingPhase: last1.ratingPhase,
  });
  const last2 = page2.hits.at(-1)!;
  if (last2.ratingPhase === undefined) throw new Error('Expected a native rating phase');
  const after2 = last2.sort;
  const page3 = await searchSubjects(search, prefix, {
    ...plan,
    size: 3,
    after: after2,
    ratingPhase: last2.ratingPhase,
  });
  const last3 = page3.hits.at(-1)!;
  if (last3.ratingPhase === undefined) throw new Error('Expected a native rating phase');
  const after3 = last3.sort;
  const exhausted = await searchSubjects(search, prefix, {
    ...plan,
    size: 3,
    after: after3,
    ratingPhase: last3.ratingPhase,
  });

  expect(page1.hits.map((hit) => hit.id)).toEqual([id(8), id(3), id(6)]);
  expect(page2.hits.map((hit) => hit.id)).toEqual([id(2), id(1), id(4)]);
  expect(page3.hits.map((hit) => hit.id)).toEqual([id(9), id(7), id(5)]);
  expect(last1.ratingPhase).toBe('scored');
  expect(last2.ratingPhase).toBe('unscored');
  expect(last3.ratingPhase).toBe('unscored');
  expect(after1).toEqual([8.25, 'rating alpha', id(6)]);
  expect(after2).toEqual(['rating alpha', id(4)]);
  expect(after3).toEqual(['rating zulu', id(5)]);
  const seen = [...page1.hits, ...page2.hits, ...page3.hits].map((hit) => hit.id);
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
  expect(exhausted.hits).toEqual([]);
  for (const page of [page1, page2, page3, exhausted]) {
    expect(page.total).toEqual({ value: 9, relation: 'exact' });
  }
});

test('rating query size accepts 1 and 200 and rejects values outside integer limits', async () => {
  const first = await searchSubjects(search, prefix, { ...plan, size: 1 });
  expect(first.hits.map((hit) => hit.id)).toEqual([id(8)]);
  expect(first.total).toEqual({ value: 9, relation: 'exact' });
  const maximum = await searchSubjects(search, prefix, { ...plan, size: 200 });
  expect(maximum.hits.map((hit) => hit.id)).toEqual(expected);
  for (const size of [0, -1, 201, 1.5, NaN, Infinity]) {
    expect(() => searchSubjects(search, prefix, { ...plan, size })).toThrow(RangeError);
  }
});

// Additive hit-only acceptance keeps the counted scenarios above unchanged.

type HitTuple = (string | number | null)[];
type HitReply = {
  timed_out: boolean;
  terminated_early?: boolean;
  _shards: { total: number; successful: number; skipped: number; failed: number };
  hits: { hits: { _id: string; _index: string; _source: Record<string, unknown>; sort: HitTuple }[]; total?: unknown };
  aggregations?: { overflow: { doc_count: number } };
};
type HitCall = { path: string; body: { id: string; params: Record<string, unknown> }; reply: HitReply };

test('native hit-only rating phases fill slots without counts and preserve every native frontier and failure', async () => {
  const hitPrefix = `hits-phases-${crypto.randomUUID().slice(0, 8)}-`;
  const physical = (generation: number) => subjectIndexName(hitPrefix, generation);
  const current = { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 7 };
  const common = { match: { search_text: { query: 'needle', operator: 'and', _name: 'text' } } };
  const book = { term: { type: { value: 'schema:Book', _name: 'book' } } };
  const base = { query: common, filter: book, sort: 'rating', rating: current, generation: 1 } satisfies Omit<
    SearchPlan,
    'size'
  >;
  const hitId = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
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
  ];
  const scored = [2, 3, 1, 4, 5, 6].map(hitId);
  const unscored = [7, 9, 10, 8, 11, 12, 13, 14].map(hitId);
  const allNames = [7, 2, 3, 9, 10, 8, 11, 12, 13, 1, 5, 4, 6, 14].map(hitId);
  const templateNames = [HIT_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE];
  const node = await search.request<{ version: { number: string; distribution: string } }>('GET', '/');
  expect(node.body.version).toMatchObject({ distribution: 'opensearch' });
  expect(node.body.version.number).toMatch(/^3\.9\./);
  const evidence: HitCall[] = [];
  const growth: { unrelated: number; size: number; iterations: number; engineCalls: number; candidates: number }[] = [];
  const recording = (mutate?: (reply: HitReply, ordinal: number) => void | Promise<void>) => {
    const calls: HitCall[] = [];
    const client: OpenSearch = {
      bulk: search.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await search.request<T>(...args);
        if (args[1].endsWith('/_search/template')) {
          const reply = response.body as HitReply;
          calls.push({
            path: args[1],
            body: structuredClone(args[2]) as HitCall['body'],
            reply: structuredClone(reply),
          });
          evidence.push(calls.at(-1)!);
          expect(args[3]?.query?.allow_partial_search_results).toBe(false);
          await mutate?.(reply, calls.length);
        }
        return response;
      },
    };
    return { client, calls };
  };
  async function run(patch: Partial<SearchPlan> = {}, observer = recording()) {
    const result = await searchSubjectHits(observer.client, hitPrefix, { ...base, size: 7, ...patch });
    expect(result).not.toHaveProperty('total');
    expect(result.generation).toBe(patch.generation ?? 1);
    expect(observer.calls.length).toBeGreaterThan(0);
    expect(observer.calls.length).toBeLessThanOrEqual(2);
    let remaining = patch.size ?? 7;
    for (const call of observer.calls) {
      expect(call.path).toBe(`/${physical(patch.generation ?? 1)}/_search/template`);
      expect(call.body.id).toBe(`${hitPrefix}${HIT_TEMPLATE}`);
      expect(call.body.params.size).toBeGreaterThan(0);
      expect(Number(call.body.params.size)).toBeLessThanOrEqual(remaining);
      expect(call.body.params).not.toHaveProperty('track_total_hits');
      expect(call.reply.hits).not.toHaveProperty('total');
      expect(call.reply.hits.hits.length).toBeLessThanOrEqual(Number(call.body.params.size));
      remaining -= call.reply.hits.hits.length;
      expect(call.reply.timed_out).toBe(false);
      expect(call.reply._shards.failed).toBe(0);
    }
    for (const hit of result.hits) {
      const raw = observer.calls.flatMap((call) => call.reply.hits.hits).find((entry) => entry._id === hit.id)!;
      expect(raw).toBeDefined();
      expect(hit.sort).toEqual(raw.sort);
      expect(hit.index).toBe(raw._index);
      expect(hit.partition).toBe(10);
      expect(hit.securityRevision).toBe(3);
      expect(hit.matched).toContain('text');
      expect(hit.matched).toContain('book');
    }
    return { result, calls: observer.calls };
  }
  try {
    for (const generation of [1, 2]) await createSubjectIndex(search, hitPrefix, generation);
    await installTemplates(search, hitPrefix);
    // This is the actual installed immutable template, not a test-only alternate request body.
    const template = await search.request<{ script: { source: string } }>(
      'GET',
      `/_scripts/${hitPrefix}${HIT_TEMPLATE}`,
    );
    expect(template.body.script.source).toContain('"track_total_hits": false');
    const bulk = await search.bulk<{ errors: boolean }>(
      rows.flatMap((row) => [
        { index: { _index: physical(1), _id: hitId(row.n) } },
        {
          id: hitId(row.n),
          partition: 10,
          security_revision: 3,
          type: 'schema:Book',
          names: ['needle'],
          name_sort: row.name,
          statements: [],
          facts: [],
          relation_facet_overflow: ['overflow-property'],
          ...('score' in row ? { rating_score: row.score } : {}),
          ...('epoch' in row ? { rating_prior_epoch: row.epoch } : {}),
        },
      ]),
      { query: { refresh: 'wait_for' } },
    );
    expect(bulk.errors).toBe(false);
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: physical(1), alias: subjectAlias(hitPrefix) } }],
    });
    const filled = await run({ size: 3 });
    expect(filled.result.hits.map((hit) => hit.id)).toEqual(scored.slice(0, 3));
    expect(filled.calls.map((call) => call.body.params.size)).toEqual([3]);
    const exactA = await run({ size: 6 });
    expect(exactA.result.hits.map((hit) => hit.id)).toEqual(scored);
    expect(exactA.calls).toHaveLength(1);
    const mixed = await run();
    expect(mixed.result.hits.map((hit) => hit.id)).toEqual([...scored, unscored[0]!]);
    expect(mixed.calls.map((call) => call.body.params.size)).toEqual([7, 1]);
    expect(mixed.result.hits[0]!.sort).toEqual([8, 'alpha', hitId(2)]);
    expect(mixed.result.hits[5]!.sort).toEqual([0, null, hitId(6)]);
    expect(mixed.result.hits[6]!.sort).toEqual(['aardvark', hitId(7)]);
    const continuation = await run({ ratingPhase: 'unscored', after: mixed.result.hits.at(-1)!.sort });
    expect(continuation.result.hits.map((hit) => hit.id)).toEqual(unscored.slice(1));
    expect(continuation.calls).toHaveLength(1);
    expect(continuation.calls[0]!.body.params.after).toEqual(['aardvark', hitId(7)]);
    const nullPrior = await run({ rating: { ...current, priorEpoch: null }, size: 200 });
    expect(nullPrior.result.hits.map((hit) => hit.id)).toEqual(allNames);
    expect(nullPrior.result.hits.every((hit) => hit.ratingPhase === 'unscored')).toBe(true);
    expect(nullPrior.calls).toHaveLength(1);
    const noCurrent = await run({ rating: { ...current, priorEpoch: 99 }, size: 200 });
    expect(noCurrent.result.hits.map((hit) => hit.id)).toEqual(allNames);
    expect(noCurrent.calls.map((call) => call.reply.hits.hits.length)).toEqual([0, 14]);
    const empty = await run({ filter: { term: { id: hitId(999) } } });
    expect(empty.result.hits).toEqual([]);
    expect(empty.calls.map((call) => call.body.params.size)).toEqual([7, 7]);
    expect((await run({ generation: 2 })).result.hits).toEqual([]);
    const withOverflow = await run({ overflowProperties: ['overflow-property'] });
    expect(withOverflow.result.overflow).toBe(true);
    expect((await run({ overflowProperties: ['absent-property'] })).result.overflow).toBe(false);
    for (const sort of ['name', 'id', 'relevance', 'collections'] as const) {
      const observer = recording();
      const ordinary = await searchSubjectHits(observer.client, hitPrefix, { ...base, sort, size: 200 });
      expect(ordinary).not.toHaveProperty('total');
      expect(ordinary.hits).toHaveLength(14);
      expect(observer.calls).toHaveLength(1);
      expect(observer.calls[0]!.body.id).toBe(`${hitPrefix}${HIT_TEMPLATE}`);
      expect(observer.calls[0]!.reply.hits).not.toHaveProperty('total');
    }
    // Resuming the last consumed A tuple retains every fetched-but-unconsumed A/B hit.
    for (const consumed of [mixed.result.hits[1]!, mixed.result.hits[5]!]) {
      const resumed = await run({ ratingPhase: consumed.ratingPhase!, after: consumed.sort });
      const offset = [...scored, ...unscored].indexOf(consumed.id) + 1;
      expect(resumed.result.hits.map((hit) => hit.id)).toEqual([...scored, ...unscored].slice(offset, offset + 7));
      expect(resumed.calls[0]!.body.params.after).toEqual(consumed.sort);
      expect(resumed.calls[1]!.body.params.has_after).toBe(false);
    }
    // Three unrelated native populations retain request/candidate/iterator bounds. This is not a Lucene-work claim.
    for (const unrelated of [0, 37, 211]) {
      if (unrelated) {
        expect(
          await search.bulk<{ errors: boolean }>(
            Array.from({ length: unrelated }, (_, n) => n + 1000).flatMap((n) => [
              { index: { _index: physical(1), _id: hitId(n) } },
              {
                id: hitId(n),
                partition: 10,
                security_revision: 3,
                type: 'schema:Recipe',
                names: ['needle'],
                name_sort: 'unrelated',
                rating_score: 10,
                rating_prior_epoch: 7,
              },
            ]),
            { query: { refresh: 'wait_for' } },
          ),
        ).toMatchObject({ errors: false });
      }
      for (const size of [1, 3, 6, 7, 14, 200]) {
        let resume: Partial<SearchPlan> = {};
        const seen: string[] = [];
        let iterations = 0;
        let engineCalls = 0;
        for (; iterations < 20; iterations++) {
          const page = await run({ size, ...resume });
          engineCalls += page.calls.length;
          seen.push(...page.result.hits.map((hit) => hit.id));
          if (page.result.hits.length < size) break;
          const last = page.result.hits.at(-1)!;
          resume = { ratingPhase: last.ratingPhase!, after: last.sort };
        }
        expect(iterations).toBeLessThan(20);
        expect(seen).toEqual([...scored, ...unscored]);
        expect(new Set(seen).size).toBe(14);
        expect(engineCalls).toBeLessThanOrEqual(2 * (iterations + 1));
        growth.push({ unrelated, size, iterations: iterations + 1, engineCalls, candidates: seen.length });
      }
      const sparse = await run({
        filter: { bool: { filter: [book, { terms: { id: [hitId(6), hitId(14)] } }] } },
        size: 1,
      });
      expect(sparse.result.hits.map((hit) => hit.id)).toEqual([hitId(6)]);
      const sparseTail = await run({
        filter: { bool: { filter: [book, { terms: { id: [hitId(6), hitId(14)] } }] } },
        size: 2,
        ratingPhase: 'scored',
        after: sparse.result.hits[0]!.sort,
      });
      expect(sparseTail.result.hits.map((hit) => hit.id)).toEqual([hitId(14)]);
    }
    const exhausted = await run({ ratingPhase: 'unscored', after: [null, hitId(14)] });
    expect(exhausted.result.hits).toEqual([]);
    expect(exhausted.calls).toHaveLength(1);
    // Each explicit legacy count case stays counted; native request reductions are 2->1, 2->2, 2->1, 1->1.
    for (const patch of [
      { size: 3 },
      { size: 7 },
      { size: 7, ratingPhase: 'unscored' as const, after: ['aardvark', hitId(7)] },
      { size: 200, rating: { ...current, priorEpoch: null } },
    ]) {
      const observer = recording();
      const legacy = await searchRatingSubjects(observer.client, hitPrefix, { ...base, ...patch }, SEARCH_TEMPLATE);
      expect(legacy.total).toEqual({ value: 14, relation: 'exact' });
      expect(observer.calls).toHaveLength(patch.rating?.priorEpoch === null ? 1 : 2);
      expect(observer.calls.every((call) => call.body.id === `${hitPrefix}${SEARCH_TEMPLATE}`)).toBe(true);
      expect(observer.calls.every((call) => call.reply.hits.total !== undefined)).toBe(true);
    }
    // A real alias switch between phases never changes the concrete query target; final freshness stays the caller's job.
    const switcher = recording(async (_reply, ordinal) => {
      if (ordinal === 1)
        await search.request('POST', '/_aliases', {
          actions: [
            { remove: { index: physical(1), alias: subjectAlias(hitPrefix) } },
            { add: { index: physical(2), alias: subjectAlias(hitPrefix) } },
          ],
        });
    });
    const { generation: _generation, ...unPinned } = base;
    const switched = await searchSubjectHits(switcher.client, hitPrefix, { ...unPinned, size: 7 });
    expect(switched.generation).toBe(1);
    expect(switched.hits.map((hit) => hit.id)).toEqual([...scored, unscored[0]!]);
    expect(switcher.calls.every((call) => call.path === `/${physical(1)}/_search/template`)).toBe(true);
    // Negative controls mutate only replies actually obtained from the check node.
    const corruptions: ((reply: HitReply) => void)[] = [
      (reply) => {
        reply.timed_out = true;
      },
      (reply) => {
        delete (reply as Partial<HitReply>).timed_out;
      },
      (reply) => {
        reply._shards.failed = 1;
      },
      (reply) => {
        reply._shards.successful = 0;
      },
      (reply) => {
        reply._shards.skipped = reply._shards.total + 1;
      },
      (reply) => {
        reply.terminated_early = true;
      },
      (reply) => {
        reply.hits.hits[0]!._index = physical(2);
      },
      (reply) => {
        reply.hits.hits[0]!._source.partition = 11;
      },
      (reply) => {
        reply.hits.hits[0]!._source.security_revision = -1;
      },
      (reply) => {
        reply.hits.hits[0]!.sort = ['wrong'];
      },
      (reply) => {
        reply.hits.hits[0]!.sort[0] = false as unknown as number;
      },
      (reply) => {
        reply.hits.hits[0]!.sort[reply.hits.hits[0]!.sort.length - 1] = hitId(999);
      },
      (reply) => {
        (reply.hits.hits[0] as unknown as Record<string, unknown>).matched_queries = [42];
      },
      (reply) => {
        reply.hits.hits.push(reply.hits.hits[0]!);
      },
      (reply) => {
        reply.hits.hits.reverse();
      },
    ];
    for (const failureAt of [1, 2]) {
      for (const corrupt of corruptions) {
        const observer = recording((reply, ordinal) => {
          if (ordinal === failureAt) corrupt(reply);
        });
        await expect(searchSubjectHits(observer.client, hitPrefix, { ...base, size: 200 })).rejects.toBeInstanceOf(
          SearchUnavailableError,
        );
        expect(observer.calls).toHaveLength(failureAt);
      }
      for (const corrupt of [
        (reply: HitReply) => {
          delete reply.aggregations;
        },
        (reply: HitReply) => {
          reply.aggregations!.overflow.doc_count = -1;
        },
      ]) {
        const observer = recording((reply, ordinal) => {
          if (ordinal === failureAt) corrupt(reply);
        });
        await expect(
          searchSubjectHits(observer.client, hitPrefix, {
            ...base,
            size: 200,
            overflowProperties: ['overflow-property'],
          }),
        ).rejects.toBeInstanceOf(SearchUnavailableError);
      }
    }
    // A well-formed but backward/repeated native tuple cannot advance a keyset.
    const backward = recording((reply) => {
      reply.hits.hits[0]!.sort = [8, 'alpha', hitId(3)];
      reply.hits.hits[0]!._id = hitId(3);
    });
    await expect(
      searchSubjectHits(backward.client, hitPrefix, {
        ...base,
        size: 1,
        ratingPhase: 'scored',
        after: [8, 'alpha', hitId(3)],
      }),
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    const outage = recording(() => {
      throw new SearchUnavailableError('native response transport negative control');
    });
    await expect(searchSubjectHits(outage.client, hitPrefix, { ...base, size: 1 })).rejects.toBeInstanceOf(
      SearchUnavailableError,
    );
    await search.request('DELETE', `/${physical(2)}`);
    await expect(searchSubjectHits(search, hitPrefix, { ...base, size: 1, generation: 2 })).rejects.toBeInstanceOf(
      SearchUnavailableError,
    );
    // The native helper and ordinary dispatcher share the exact count-free result type and template.
    const direct: HitResult = await searchRatingSubjectHits(search, hitPrefix, { ...base, size: 1 });
    expect(direct.hits.map((hit) => hit.id)).toEqual(scored.slice(0, 1));
    expect(direct).not.toHaveProperty('total');
  } finally {
    await Bun.write(
      new URL(`../../../../.temp/rating-hit-evidence-${hitPrefix}.json`, import.meta.url),
      JSON.stringify({ node: node.body, growth, calls: evidence }),
    );
    for (const generation of [1, 2])
      await search.request('DELETE', `/${physical(generation)}`).catch((error) => {
        if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
      });
    for (const name of templateNames)
      await search.request('DELETE', `/_scripts/${hitPrefix}${name}`).catch((error) => {
        if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
      });
  }
}, 120_000);
