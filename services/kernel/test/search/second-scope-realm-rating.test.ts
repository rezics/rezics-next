import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { decodeSearchCursor } from '../../src/search/cursor.ts';
import { normalizePublicRatingFigure } from '../../src/search/rating-source.ts';
import {
  readRealmRatingOrder,
  type RealmRatingContext,
  type RealmRatingHit,
  type RealmRatingQuery,
  type RealmRatingSource,
} from '../../src/search/realm-rating-order.ts';
import { createFakeSource } from './support/fake-source.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const populationId = id(900);
const release = {
  types: { 'schema:Book': { facets: [] }, 'schema:Game': { facets: [] } },
  properties: {},
};
const binding = {
  operation: 'subjects.search.realm_rating',
  principal: 'anonymous',
  request: { sort: 'rating' },
};

// Native owner fixture: it retains the COMPLETE canonical population, not a fetched Search page.
// No production readiness is inferred from this provider; missing native composition is tested below.
function fixture(priorEpoch: number | null = 17) {
  const source = createFakeSource();
  let context: RealmRatingContext = {
    questionId: STANDARD_QUESTION_ID,
    populationId,
    priorEpoch,
    realm: { authority: 'read-ban-1', revision: 'population-figures-1' },
    generation: 1,
    asOf: '2026-11-01T00:00:00.000Z',
  };
  const scores = priorEpoch === null ? [null, null, null, null, null, null] : [9, 9, 9, 0, null, null];
  const names = ['A', 'A', null, 'B', 'C', 'D'];
  const hits: RealmRatingHit[] = scores.map((score, index) => {
    const subjectId = id(index + 1);
    source.put({
      id: subjectId,
      type: index === 2 ? 'schema:Game' : 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: names[index] === null ? [] : [{ language: 'en', value: names[index]! }],
      aliases: [],
      descriptions: [],
      statements: [],
    });
    return {
      id: subjectId,
      index: 'native-realm',
      partition: 10,
      securityRevision: 1,
      matched: [],
      position: 0n,
      threshold: 5,
      figure:
        index === 5
          ? null
          : {
              questionId: STANDARD_QUESTION_ID,
              populationId,
              subjectId,
              count: index === 4 ? 4 : 5,
              mean: index === 4 ? null : 5,
              score,
              priorEpoch,
              revision: '3',
              asOf: context.asOf,
            },
      ratingPhase: score === null ? 'unscored' : 'scored',
      sort: score === null ? [names[index]!, subjectId] : [score, names[index]!, subjectId],
    };
  });
  if (priorEpoch === null)
    hits.sort((a, b) =>
      a.sort[0] === null ? 1 : b.sort[0] === null ? -1 : String(a.sort[0]).localeCompare(String(b.sort[0])),
    );
  const query: RealmRatingQuery = {
    principal: 'anonymous',
    populationId,
    release,
    meaningDigest: 'meaning-1',
    text: undefined,
    filter: undefined,
    deadline: Date.now() + 60_000,
  };
  let observed: RealmRatingQuery | undefined;
  let reads = 0;
  let denied = false;
  let unavailable = false;
  const ratings: RealmRatingSource = {
    async observe(input) {
      observed = input;
      if (denied) throw new ProblemError('forbidden');
      if (unavailable) throw new Error('native population unavailable');
      return structuredClone(context);
    },
    async read(input, _context, request) {
      reads++;
      if (unavailable) throw new Error('native figures unavailable');
      // Fixed, owner-evaluated test predicate; assert the complete parser trees reach this seam.
      const population = input.text || input.filter ? hits.filter((hit) => hit.id === id(2) || hit.id === id(5)) : hits;
      const start = request.after ? population.findIndex((hit) => hit.id === request.after!.at(-1)) + 1 : 0;
      const position = (await source.read(10, [])).position;
      return {
        context: structuredClone(context),
        hits: population.slice(start, start + request.size).map((hit) => ({ ...hit, position })),
      };
    },
  };
  return {
    source,
    ratings,
    query,
    hits,
    run: (cursor?: string, limit = 2) =>
      readRealmRatingOrder({
        ratings,
        source,
        query,
        cursors: ring,
        binding,
        limit,
        now: 1000,
        ...(cursor ? { cursor } : {}),
      }),
    switch: (change: Partial<RealmRatingContext>) => {
      context = { ...context, ...change };
    },
    deny: () => {
      denied = true;
    },
    fail: () => {
      unavailable = true;
    },
    observed: () => observed,
    reads: () => reads,
  };
}

test('selected native Realm traverses scored ties, zero, below-threshold and absent figures once', async () => {
  const f = fixture();
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.run(cursor);
    seen.push(...page.subjects.map((subject) => subject.id));
    await page.finalize();
    cursor = page.next ?? undefined;
    if (cursor) expect((await decodeSearchCursor(ring, binding, cursor, 1001)).ok).toBe(true);
  } while (cursor);
  expect(seen).toEqual([1, 2, 3, 4, 5, 6].map(id));
  expect(new Set(seen).size).toBe(seen.length);
  const unscored = fixture(null);
  // A known ineligible current prior makes even retained published scores unscored.
  Object.assign(unscored.hits[0]!.figure!, { score: 9, priorEpoch: 16 });
  expect((await unscored.run(undefined, 100)).subjects.map((subject) => subject.id)).toEqual(
    [1, 2, 4, 5, 6, 3].map(id),
  );
  const stale = fixture();
  const old = stale.hits.shift()!;
  old.figure!.priorEpoch = 16;
  old.ratingPhase = 'unscored';
  old.sort = ['A', old.id];
  stale.hits.splice(3, 0, old);
  expect((await stale.run(undefined, 100)).subjects.map((subject) => subject.id)).toEqual([2, 3, 4, 1, 5, 6].map(id));
});

test('current population, frozen prior, figure revision and Realm authority invalidate continuation', async () => {
  for (const change of [
    { priorEpoch: 18 },
    { priorEpoch: null },
    { generation: 2 },
    { realm: { authority: 'read-ban-2', revision: 'population-figures-1' } },
    { realm: { authority: 'read-ban-1', revision: 'population-figures-2' } },
  ]) {
    const f = fixture();
    const page = await f.run();
    f.switch(change);
    await expect(f.run(page.next!)).rejects.toMatchObject({
      code: 'search_restart_required',
    });
    await expect(page.finalize()).rejects.toMatchObject({
      code: 'search_restart_required',
    });
  }
  const f = fixture();
  const page = await f.run();
  f.switch({ populationId: id(901) });
  await expect(f.run(page.next!)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
});

test('denial, unavailable evidence, stale figures and mismatched anchors cannot become unscored', async () => {
  for (const fault of ['deny', 'fail'] as const) {
    const f = fixture();
    const page = await f.run();
    f[fault]();
    await expect(f.run(page.next!)).rejects.toMatchObject({
      code: fault === 'deny' ? 'forbidden' : 'index_not_ready',
    });
    await expect(page.finalize()).rejects.toMatchObject({
      code: fault === 'deny' ? 'forbidden' : 'index_not_ready',
    });
  }
  for (const patch of [{ populationId: id(901) }, { priorEpoch: 16 }, { count: 4 }, { revision: '0' }]) {
    const f = fixture();
    Object.assign(f.hits[0]!.figure!, patch);
    await expect(f.run()).rejects.toMatchObject({ code: 'index_not_ready' });
  }
  const f = fixture();
  const read = f.source.read.bind(f.source);
  f.source.read = async (partition, ids) => {
    const snapshot = await read(partition, ids);
    return { ...snapshot, position: snapshot.position + (ids.length ? 1n : 0n) };
  };
  await expect(f.run()).rejects.toMatchObject({ code: 'index_not_ready' });
});

test('service forwards text and filters to the native order; only Global figures reach public output', async () => {
  const f = fixture();
  let engineCalls = 0;
  const client = {
    request: async () => {
      engineCalls++;
      throw new Error('Realm ordering entered public index');
    },
  } as unknown as OpenSearch;
  const service = createSearchService({
    pool,
    client,
    prefix: 'realm-',
    source: f.source,
    realmRatings: f.ratings,
    cursors: ring,
    release: async () => release,
  });
  const request = {
    sort: 'rating' as const,
    population: { realm: populationId },
    text: '"Deep field" | bonus',
    filter: { type: { in: ['schema:Book'] } },
    limit: 10,
  };
  const page = await service.search('anonymous', request);
  expect(page.subjects.map((subject) => subject.id)).toEqual([id(2), id(5)]);
  expect(f.observed()).toMatchObject({
    populationId,
    filter: request.filter,
    text: { kind: 'or' },
  });
  expect(page.next).toBeNull();
  expect(page).not.toHaveProperty('total');
  expect(page.subjects.every((subject) => subject.figure.populationId === GLOBAL_CONTEXT.id)).toBe(true);
  expect(engineCalls).toBe(0);
  const realmFigure = f.hits[0]!.figure!;
  expect(() =>
    normalizePublicRatingFigure(realmFigure, {
      questionId: realmFigure.questionId,
      populationId,
      subjectId: realmFigure.subjectId,
    }),
  ).toThrow();
  const unavailable = createSearchService({
    pool,
    client,
    prefix: 'realm-',
    source: f.source,
    cursors: ring,
    release: async () => release,
  });
  await expect(unavailable.search('anonymous', request)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
  await expect(service.search('anonymous', { ...request, sort: 'name' })).rejects.toMatchObject({
    code: 'unsupported_query',
  });
  const kernel = createKernel({
    pool,
    receiptKeys: testReceiptKeys(),
    routeKey: new Uint8Array(32).fill(13),
    search: unavailable,
    access: {
      async authenticate() {
        throw new Error('no credentials');
      },
      async authorize() {
        return true;
      },
    },
  });
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('index_not_ready');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
