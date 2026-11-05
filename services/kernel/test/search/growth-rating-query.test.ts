import { afterAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { measurePublicFilterIteratorSteps } from '../../src/search/public-filter-consumer.ts';
import { installTemplates, SEARCH_TEMPLATE, searchSubjects, type SearchResult } from '../../src/search/query.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const native = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const generation = 1;
const index = subjectIndexName(prefix, generation);
const rating = { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id, priorEpoch: 7 };
type Phase = 'scored' | 'unscored';
type Tuple = (string | number | null)[];
// Structural bridge for an additive capability absent on older bases. Discovery happens only after native baseline.
// Keep the ordinary query inputs identical to SearchPlan; these are trusted internal metadata, not caller DSL.
type RatingPlan = Omit<Parameters<typeof searchSubjects>[2], 'sort'> & {
  rating: typeof rating;
  generation: number;
  ratingPhase?: Phase;
};
type RatingResult = SearchResult & { generation?: number };
type RatingQuery = (search: OpenSearch, prefix: string, plan: RatingPlan, template: string) => Promise<RatingResult>;
type RawHit = { _id: string; _index: string; sort: Tuple };
type Capture = {
  path: string;
  body: unknown;
  options: unknown;
  hits: RawHit[];
  total: unknown;
  iteratorSteps: number;
};
const phases: Capture[] = [];
const other: { method: string; path: string }[] = [];
const transport: OpenSearch = {
  async request<T>(
    method: Parameters<OpenSearch['request']>[0],
    path: string,
    body?: unknown,
    options?: Parameters<OpenSearch['request']>[3],
  ) {
    // Record the actual engine response. Profile is added only so iterator steps can be counted.
    const profiled = /\/_search(?:\/template)?$/.test(path);
    const requestOptions = profiled ? { ...options, query: { ...options?.query, profile: true } } : options;
    const response = await native.request<T>(method, path, body, requestOptions);
    if (profiled) {
      const raw = response.body as { hits: { hits: RawHit[]; total: unknown } };
      phases.push({
        path,
        body: structuredClone(body),
        options: structuredClone(requestOptions),
        hits: structuredClone(raw.hits.hits),
        total: raw.hits.total,
        iteratorSteps: measurePublicFilterIteratorSteps(response.body),
      });
    } else other.push({ method, path });
    return response;
  },
  bulk: (lines, options) => native.bulk(lines, options),
};

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
type Fixture = {
  ordinal: number;
  score?: number | null;
  epoch?: number | null;
  name: string | null;
  selective: boolean;
};
function fixture(ordinal: number): Fixture {
  // Current scored rows include real zero. Width/case variants tie under actual ICU normalization.
  if (ordinal < 16)
    return {
      ordinal,
      score: ordinal < 8 ? 9 : 0,
      epoch: 7,
      name: ordinal % 2 ? 'ＫＯＫＯＲＯ' : 'Kokoro',
      selective: ordinal % 2 === 0,
    };
  const kind = ordinal % 5;
  return {
    ordinal,
    ...(kind === 0
      ? { score: 10, epoch: 6 }
      : kind === 1
        ? { score: null, epoch: 7 }
        : kind === 2
          ? { epoch: 7 }
          : kind === 3
            ? { score: 10, epoch: null }
            : { score: 10 }),
    name: ordinal % 11 === 0 ? null : ordinal % 2 ? 'ＫＯＫＯＲＯ' : 'Kokoro',
    selective: ordinal % 2 === 0,
  };
}
function lines(row: Fixture, unrelated = false): unknown[] {
  const subject: IndexedSubject = {
    id: id(row.ordinal + (unrelated ? 10000 : 0)),
    type: row.selective ? 'schema:Book' : 'schema:Recipe',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: unrelated ? 'Unrelated' : 'Growth' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const actions = documentActions({ partition: 10, position: 1n, subjects: [subject] }, [subject.id]);
  // Extend serialized ENGINE fixture documents, without widening the production document producer's type.
  return bulkLines(index, actions).map((line, offset) =>
    offset % 2 === 0
      ? line
      : {
          ...(line as Record<string, unknown>),
          name_sort: row.name,
          ...(row.score === undefined ? {} : { rating_score: row.score }),
          ...(row.epoch === undefined ? {} : { rating_prior_epoch: row.epoch }),
        },
  );
}
async function grow(from: number, to: number): Promise<void> {
  // At most 128 matching plus 128 unrelated documents per bulk; no all-population response is fetched.
  for (let start = from; start < to; start += 128) {
    const batch = Array.from({ length: Math.min(128, to - start) }, (_, n) => fixture(start + n));
    const result = await native.bulk<{ errors: boolean; items: { index: { status: number } }[] }>(
      batch.flatMap((row) => [...lines(row), ...lines(row, true)]),
    );
    expect(result.errors).toBe(false);
    expect(result.items.every((item) => item.index.status === 201)).toBe(true);
  }
  await native.request('POST', `/${index}/_refresh`);
}
function isScored(row: Fixture): boolean {
  return row.epoch === 7 && typeof row.score === 'number';
}
function expected(population: number, selective: boolean): Fixture[] {
  // Fixture oracle only, never a query runtime. Every nonnull key is the same normalized ICU key.
  return Array.from({ length: population }, (_, n) => fixture(n))
    .filter((row) => !selective || row.selective)
    .sort(
      (a, b) =>
        Number(isScored(b)) - Number(isScored(a)) ||
        (isScored(a) && isScored(b) ? b.score! - a.score! : 0) ||
        Number(a.name === null) - Number(b.name === null) ||
        a.ordinal - b.ordinal,
    );
}
function nativeTuple(row: Fixture): Tuple {
  return [...(isScored(row) ? [row.score!] : []), row.name === null ? null : 'kokoro', id(row.ordinal)];
}
let created = false;
afterAll(async () => {
  if (created) await native.request('DELETE', `/${index}`);
  // Only scripts installed under this owned prefix are removed.
  for (const name of ['subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1']) {
    await native.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
});

test('native rating candidate delivery remains within shared phase quotas as the real indexed matching population grows', async () => {
  const version = await native.request<{ version: { number: string } }>('GET', '/');
  expect(version.body.version.number).toBe('3.9.0');
  await createSubjectIndex(native, prefix, generation);
  created = true;
  // Explicit disposable ENGINE fixture fields: no claim about native vote publication, privacy or API disclosure.
  await native.request('PUT', `/${index}/_mapping`, {
    properties: {
      rating_score: { type: 'double', coerce: false, doc_values: true },
      rating_prior_epoch: { type: 'long', coerce: false, doc_values: true },
    },
  });
  await native.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  await installTemplates(native, prefix);
  await grow(0, 64);
  const query = { match: { search_text: { query: 'Growth', operator: 'and' } } };
  // Legal production mapping/template/ICU baseline must succeed before optional additive helper discovery.
  const baseline = await searchSubjects(transport, prefix, { query, sort: 'id', size: 1 });
  expect(baseline.hits.map((hit) => hit.id)).toEqual([id(0)]);
  expect(baseline.total).toEqual({ value: 64, relation: 'exact' });
  const moduleUrl = new URL('../../src/search/rating-query.ts', import.meta.url);
  const module = (await Bun.file(moduleUrl).exists())
    ? ((await import(moduleUrl.href)) as Record<string, unknown>)
    : {};
  expect(
    module.searchRatingSubjects,
    'Native baseline passed; adopted two-phase searchRatingSubjects capability is required',
  ).toBeFunction();
  const searchRatingSubjects = module.searchRatingSubjects as RatingQuery;

  let previous = 64;
  for (const population of [64, 512, 4096]) {
    await grow(previous, population);
    previous = population;
    // Counts are separate indexed observations, never current public lower bounds or engine-work metrics.
    const count = await native.request<{ count: number }>('POST', `/${index}/_count`, { query });
    expect(count.body.count).toBe(population);
    for (const selective of [false, true]) {
      const rows = expected(population, selective);
      const filter = selective ? { term: { type: 'schema:Book' } } : undefined;
      const scored = rows.filter(isScored);
      const run = async () => {
        let delivered = 0;
        let iteratorSteps = 0;
        const records: { requests: Capture[]; discovery: typeof other; quota: number; iteratorSteps: number }[] = [];
        async function call(size: number, after?: Tuple, ratingPhase?: Phase): Promise<RatingResult> {
          phases.length = 0;
          other.length = 0;
          const plan: RatingPlan = {
            query,
            ...(filter ? { filter } : {}),
            size,
            rating,
            generation,
            ...(after ? { after } : {}),
            ...(ratingPhase ? { ratingPhase } : {}),
          };
          const result = await searchRatingSubjects(transport, prefix, plan, SEARCH_TEMPLATE);
          expect(result.generation).toBe(generation);
          expect(result.hits.length).toBeGreaterThan(0);
          expect(phases.length).toBeGreaterThan(0);
          expect(phases.length).toBeLessThanOrEqual(2);
          for (const request of other) {
            expect(['GET', 'HEAD']).toContain(request.method);
            expect(request.path).not.toMatch(/\/_(?:count|msearch)(?:[/?]|$)/);
          }
          const raw = phases.flatMap((request) => request.hits);
          expect(raw.length).toBeLessThanOrEqual(size);
          let remaining = size;
          for (const request of phases) {
            expect(request.path).toMatch(new RegExp(`^/${index}/_search(?:/template)?$`));
            const body = request.body as { size?: number; params?: { size: number } };
            const requested = body.params?.size ?? body.size!;
            expect(Number.isInteger(requested)).toBe(true);
            expect(requested).toBeGreaterThanOrEqual(0);
            expect(requested).toBeLessThanOrEqual(remaining);
            expect(request.hits.length).toBeLessThanOrEqual(requested);
            // A may request q but return short; B can request only q minus those actual A hits.
            remaining -= request.hits.length;
          }
          expect(size).toBeLessThanOrEqual(200);
          expect(result.hits.map((hit) => hit.id)).toEqual(raw.map((hit) => hit._id));
          for (const hit of result.hits) {
            const row = rows.find((row) => id(row.ordinal) === hit.id)!;
            expect(row).toBeDefined();
            expect(hit.index).toBe(index);
            expect(hit.sort).toEqual(nativeTuple(row));
            expect(hit).toMatchObject({
              partition: 10,
              securityRevision: 1,
              ratingPhase: isScored(row) ? 'scored' : 'unscored',
            });
          }
          delivered += raw.length;
          const steps = phases.reduce((total, request) => total + request.iteratorSteps, 0);
          expect(steps).toBeGreaterThan(0);
          iteratorSteps += steps;
          records.push({
            requests: structuredClone(phases),
            discovery: structuredClone(other),
            quota: size,
            iteratorSteps: steps,
          });
          return result;
        }
        // Full A, including zero and ICU ties. A complete quota cannot establish exhaustion.
        const first = await call(scored.length);
        expect(first.hits.map((hit) => hit.id)).toEqual(rows.slice(0, scored.length).map((row) => id(row.ordinal)));
        // Consume all but the last A hit. Continue with its actual A tuple; short A must spend only remaining q on B.
        const boundary = first.hits.at(-2)!;
        const crossing = await call(200, boundary.sort, 'scored');
        const offset = scored.length - 1;
        expect(crossing.hits.map((hit) => hit.id)).toEqual(
          rows.slice(offset, offset + 200).map((row) => id(row.ordinal)),
        );
        expect(phases).toHaveLength(2);
        expect(phases[0]!.hits).toHaveLength(1);
        expect(phases[1]!.hits.length).toBeGreaterThan(0);
        // Consume the first B hit; later returned candidates (including lookahead) remain unconsumed.
        const consumedB = crossing.hits[1]!;
        const unscored = await call(200, consumedB.sort, 'unscored');
        expect(unscored.hits.map((hit) => hit.id)).toEqual(
          rows.slice(scored.length + 1, scored.length + 201).map((row) => id(row.ordinal)),
        );
        expect(delivered).toBeLessThanOrEqual(600);
        phases.length = 0;
        other.length = 0;
        const empty = await searchRatingSubjects(
          transport,
          prefix,
          {
            query: { match: { search_text: { query: 'NoSuchRatingToken', operator: 'and' } } },
            size: 1,
            rating,
            generation,
          },
          SEARCH_TEMPLATE,
        );
        expect(empty.hits).toHaveLength(0);
        expect(phases.length).toBeGreaterThan(0);
        expect(phases.length).toBeLessThanOrEqual(2);
        const emptySteps = phases.reduce((total, request) => total + request.iteratorSteps, 0);
        iteratorSteps += emptySteps;
        return { delivered, records, iteratorSteps, emptySteps };
      };
      // Shared growth conventions: one warmup then five repetitions. Native request/cardinality evidence only;
      // PostgreSQL capture/vacuum/classifiers do not apply. Engine sorting/counting remains match-dependent.
      await run();
      for (let repetition = 0; repetition < 5; repetition++) {
        console.info(
          JSON.stringify({ evidence: 'native-rating-candidates', population, selective, repetition, ...(await run()) }),
        );
      }
    }
  }
}, 120_000);
