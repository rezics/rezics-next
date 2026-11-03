import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT, readExposure } from '../../src/access/gates/catalogue.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { decodeSearchCursor } from '../../src/search/cursor.ts';
import { normalizePublicRatingFigure } from '../../src/search/rating-source.ts';
import { parseText } from '../../src/search/text.ts';
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
const opening = Bun.randomUUIDv7();
beforeAll(async () => {
  // Dispatch fixture only; native Realm authority remains the provider's responsibility.
  for (const group of ['search', 'search_advanced']) {
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10_000)).open)
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         VALUES ($1, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2)`,
        [group, opening],
      );
  }
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
  } finally {
    await pool.end();
  }
});
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const idInSecondPartition = (n: number) => `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`;
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
function fixture(priorEpoch: number | null = 17, withSecondPartition = false) {
  const source = createFakeSource();
  const names = new Map<string, string | null>();
  let context: RealmRatingContext = {
    questionId: STANDARD_QUESTION_ID,
    populationId,
    priorEpoch,
    realm: { authority: 'read-ban-1', revision: 'population-figures-1' },
    generation: 1,
    asOf: '2026-11-01T00:00:00.000Z',
    questionIdentity: '[1,"work",0,20,1]',
    questionRevision: 1,
    questionProvenance: 'question-provenance-1',
    observation: 'observation-1',
    priorGeneration: String(priorEpoch ?? 0),
    canonicalGeneration: 'canonical-1',
    publicationGeneration: 'publication-1',
    meaningDigest: 'meaning-1',
    searchGeneration: 1,
    priorActive: priorEpoch !== null,
    priorUpdating: false,
  };
  const scores =
    priorEpoch === null ? [null, null, null, null, null, null, null, null] : [9, 9, 9, 0, null, null, 1, null];
  const labels: (string | null)[] = ['A', 'A', null, 'B', 'C', 'C', 'E', null];
  const hits: RealmRatingHit[] = scores.map((score, index) => {
    const subjectId = id(index + 1);
    names.set(subjectId, labels[index]!);
    source.put({
      id: subjectId,
      type: index === 2 ? 'schema:Game' : 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: labels[index] === null ? [] : [{ language: 'en', value: labels[index]! }],
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
        index === 4 || index === 5
          ? null
          : {
              questionId: STANDARD_QUESTION_ID,
              populationId,
              subjectId,
              count: 5,
              mean: 5,
              score,
              priorEpoch,
              revision: '3',
              asOf: context.asOf,
            },
      ratingPhase: score === null ? 'unscored' : 'scored',
      sort: score === null ? [labels[index]!, subjectId] : [score, null, subjectId],
    };
  });
  if (withSecondPartition) {
    const subjectId = idInSecondPartition(9);
    const label = 'A';
    names.set(subjectId, label);
    source.put({
      id: subjectId,
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: [{ language: 'en', value: label }],
      aliases: [],
      descriptions: [],
      statements: [],
    });
    hits.push({
      id: subjectId,
      index: 'native-realm',
      partition: 11,
      securityRevision: 1,
      matched: [],
      position: 0n,
      threshold: 5,
      figure: {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        subjectId,
        count: 5,
        mean: 5,
        score: 10,
        priorEpoch,
        revision: '3',
        asOf: context.asOf,
      },
      ratingPhase: 'scored',
      sort: [10, null, subjectId],
    });
  }
  const compareFrontier = (
    left: { after: readonly (string | number | null)[]; ratingPhase: 'scored' | 'unscored' },
    right: { after: readonly (string | number | null)[]; ratingPhase: 'scored' | 'unscored' },
  ) => {
    if (left.ratingPhase !== right.ratingPhase) return left.ratingPhase === 'scored' ? -1 : 1;
    const a = left.after;
    const b = right.after;
    if (left.ratingPhase === 'scored' && a[0] !== b[0]) return Number(b[0]) - Number(a[0]);
    const offset = left.ratingPhase === 'scored' ? 2 : 0;
    if (left.ratingPhase === 'scored') {
      const scoreCmp = Buffer.compare(Buffer.from(String(b.at(-1))), Buffer.from(String(a.at(-1))));
      return scoreCmp;
    }
    for (let index = offset; index < a.length; index++) {
      if (a[index] === b[index]) continue;
      if (a[index] === null) return 1;
      if (b[index] === null) return -1;
      return Buffer.compare(Buffer.from(String(a[index])), Buffer.from(String(b[index])));
    }
    return 0;
  };
  let textMatches = new Set([id(2), id(5)]);
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
    async readScoredFrontiers(input, _context, request) {
      reads++;
      if (unavailable) throw new Error('native figures unavailable');
      const populations = new Map<number, RealmRatingHit[]>();
      for (const hit of hits) {
        if (
          hit.ratingPhase !== 'scored' ||
          (request.after &&
            compareFrontier(
              { after: request.after, ratingPhase: 'scored' },
              { after: hit.sort, ratingPhase: 'scored' },
            ) >= 0)
        )
          continue;
        const population = populations.get(hit.partition) ?? [];
        population.push(hit);
        populations.set(hit.partition, population);
      }
      const partitions = await Promise.all(
        [...populations].map(async ([partition, population]) => {
          const position = (await source.read(partition, [])).position;
          return {
            partition,
            hits: population
              .sort((a, b) =>
                compareFrontier({ after: a.sort, ratingPhase: 'scored' }, { after: b.sort, ratingPhase: 'scored' }),
              )
              .slice(0, request.size)
              .map((hit) => ({
                ...hit,
                position,
                ...(input.text && !textMatches.has(hit.id) ? { suppressed: true as const } : {}),
              })),
          };
        }),
      );
      return {
        context: structuredClone(context),
        partitions,
      };
    },
    async readUnscored(input, _context, request) {
      reads++;
      if (unavailable) throw new Error('native figures unavailable');
      const population = hits
        .map((hit): RealmRatingHit => {
          const scored =
            context.priorEpoch !== null &&
            hit.figure !== null &&
            hit.figure.priorEpoch === context.priorEpoch &&
            hit.figure.score !== null;
          return {
            ...hit,
            ratingPhase: 'unscored',
            sort: [names.get(hit.id) ?? null, hit.id],
            position: hit.position,
            figure: scored ? null : hit.figure,
            ...(scored || (input.text && !textMatches.has(hit.id)) ? { suppressed: true as const } : {}),
          };
        })
        .sort((a, b) =>
          compareFrontier({ after: a.sort, ratingPhase: 'unscored' }, { after: b.sort, ratingPhase: 'unscored' }),
        )
        .filter(
          (hit) =>
            !request.after ||
            compareFrontier(
              { after: request.after, ratingPhase: 'unscored' },
              { after: hit.sort, ratingPhase: 'unscored' },
            ) < 0,
        )
        .slice(0, request.size);
      const positioned = await Promise.all(
        population.map(async (hit) => ({ ...hit, position: (await source.read(hit.partition, [])).position })),
      );
      return {
        context: structuredClone(context),
        hits: positioned,
      };
    },
  };
  const switchContext = (change: Partial<RealmRatingContext>) => {
    context = { ...context, ...change };
    if (change.priorEpoch !== undefined) context.priorActive = context.priorEpoch !== null;
    if (change.generation !== undefined) context.searchGeneration = context.generation;
    context.observation = createHash('sha256')
      .update(
        JSON.stringify([
          context.questionIdentity,
          context.questionRevision,
          context.questionProvenance,
          context.priorGeneration,
          context.canonicalGeneration,
          context.publicationGeneration,
          context.meaningDigest,
          context.searchGeneration,
          context.priorActive,
          context.priorUpdating,
          context.realm.authority,
          context.realm.revision,
        ]),
      )
      .digest('hex');
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
    switch: switchContext,
    rename: (subjectId: string, name: string | null) => {
      names.set(subjectId, name);
      switchContext({ canonicalGeneration: 'canonical-renamed' });
    },
    matchTextOnly: (ids: number[]) => {
      textMatches = new Set(ids.map(id));
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
    if (cursor) {
      const decoded = await decodeSearchCursor(ring, binding, cursor, 1001);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(JSON.stringify(decoded.after)).not.toContain(id(1));
    }
  } while (cursor);
  expect(seen).toEqual([3, 2, 1, 7, 4, 5, 6, 8].map(id));
  expect(new Set(seen).size).toBe(seen.length);
  const unscored = fixture(null);
  // A known ineligible current prior makes even retained published scores unscored.
  Object.assign(unscored.hits[0]!.figure!, { score: 9, priorEpoch: 16 });
  expect((await unscored.run(undefined, 100)).subjects.map((subject) => subject.id)).toEqual(
    [1, 2, 4, 5, 6, 7, 3, 8].map(id),
  );
  const stale = fixture();
  const old = stale.hits.shift()!;
  old.figure!.priorEpoch = 16;
  old.ratingPhase = 'unscored';
  old.sort = ['A', old.id];
  stale.hits.splice(3, 0, old);
  expect((await stale.run(undefined, 100)).subjects.map((subject) => subject.id)).toEqual(
    [3, 2, 7, 4, 1, 5, 6, 8].map(id),
  );
});

test('merges scored frontiers across partitions and consumes a sparsely denied subject privately', async () => {
  const f = fixture(17, true);
  const denied = (await f.source.read(10, [id(2)])).subjects[0]!;
  f.source.put({ ...denied, visibility: 'hidden' });
  const page = await f.run(undefined, 100);
  expect(page.subjects.map((subject) => subject.id)).toEqual([
    idInSecondPartition(9),
    id(3),
    id(1),
    id(7),
    id(4),
    id(5),
    id(6),
    id(8),
  ]);
  const cursor = await f.run();
  if (cursor.next) {
    const decoded = await decodeSearchCursor(ring, binding, cursor.next, 1001);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(JSON.stringify(decoded.after)).not.toContain(id(2));
  }
});

test('an admitted text hit beyond the first scored batch survives the consumed hidden frontier', async () => {
  const f = fixture();
  f.matchTextOnly([7]);
  f.query.text = parseText('tail');
  const page = await f.run(undefined, 1);
  expect(page.subjects.map((subject) => subject.id)).toEqual([id(7)]);
  expect(page.next).not.toBeNull();
  const decoded = await decodeSearchCursor(ring, binding, page.next!, 1001);
  expect(decoded.ok).toBe(true);
  if (decoded.ok) expect(JSON.stringify(decoded.after)).not.toContain(id(1));
});

test('current population, frozen prior, figure revision and Realm authority invalidate continuation', async () => {
  for (const change of [
    { priorEpoch: 18 },
    { priorEpoch: null },
    { generation: 2 },
    { questionRevision: 2 },
    { questionProvenance: 'question-provenance-2' },
    { questionIdentity: '[2,"work",0,20,1]' },
    { priorGeneration: '18' },
    { canonicalGeneration: 'canonical-2' },
    { publicationGeneration: 'publication-2' },
    { meaningDigest: 'meaning-2' },
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

test('a current name change restarts the continuation without exposing its consumed key', async () => {
  const f = fixture();
  const page = await f.run();
  f.rename(id(1), 'Z');
  await expect(f.run(page.next!)).rejects.toMatchObject({ code: 'search_restart_required' });
  const decoded = await decodeSearchCursor(ring, binding, page.next!, 1001);
  expect(decoded.ok).toBe(true);
  if (decoded.ok) expect(JSON.stringify(decoded.after)).not.toContain(id(1));
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
