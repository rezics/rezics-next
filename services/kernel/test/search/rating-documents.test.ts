import { afterAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { bulkLines, documentActions, MAX_NAME_SORT_CHARACTERS } from '../../src/search/document.ts';
import * as indices from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import type { PublicRatingFigure } from '../../src/search/rating-source.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const position = BigInt(Number.MAX_SAFE_INTEGER) - 2n;
const figure = (n: number, patch: Partial<PublicRatingFigure> = {}): PublicRatingFigure => ({
  questionId: id(90),
  populationId: GLOBAL_CONTEXT.id,
  subjectId: id(n),
  count: 8,
  mean: 9,
  score: 7.625,
  priorEpoch: 12,
  revision: '9223372036854775807',
  asOf: '2026-10-28T10:00:00Z',
  ...patch,
});
const subject = (n: number, publicRating?: PublicRatingFigure): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 3,
  labels: [{ language: 'en', value: 'ＫＯＫＯＲＯ' }],
  aliases: [],
  descriptions: [],
  statements: [],
  ...(publicRating === undefined ? {} : { publicRating }),
});
const build = (subjects: IndexedSubject[], version = position) =>
  documentActions(
    { partition: 10, position: version, subjects },
    subjects.map((item) => item.id),
  );

test('rating documents copy only eligible Global public sort fields and keep anchor versions', () => {
  const plain = build([subject(1)])[0]!;
  if (plain.op !== 'index') throw new Error('Expected a visible subject');
  for (const patch of [
    {},
    { score: 0, mean: 0 },
    { score: null },
    { score: null, priorEpoch: null },
    { count: 0, mean: null, score: null, priorEpoch: null },
  ]) {
    const published = figure(1, patch);
    const actions = build([subject(1, published)]);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    if (action.op !== 'index') throw new Error('Expected a visible subject');
    expect(action.version).toBe(position);
    expect(action.document).toEqual({
      ...plain.document,
      rating_score: published.score,
      rating_prior_epoch: published.priorEpoch,
    });
    expect(Object.keys(action.document)).toHaveLength(Object.keys(plain.document).length + 2);
    const lines = bulkLines('test-subjects-g1', actions);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      index: { _index: 'test-subjects-g1', _id: id(1), version: Number(position), version_type: 'external' },
    });
    expect(lines[1]).toBe(action.document);
  }
  expect(plain.document).not.toHaveProperty('rating_score');
  expect(plain.document).not.toHaveProperty('rating_prior_epoch');
});

test('private or mismatched figure keys are rejected by the shared public figure validator', () => {
  const invalid = [
    { populationId: id(91) },
    { subjectId: id(2) },
    { voter: id(92) },
    { score: '7.625' },
    { score: [7.625] },
    { score: NaN },
    { score: 11 },
    { priorEpoch: 0 },
    { priorEpoch: null },
    { count: 4 },
    { revision: '1.5' },
    { asOf: 'yesterday' },
  ];
  for (const patch of invalid) {
    const untrusted = { ...figure(1), ...patch } as PublicRatingFigure;
    expect(() => build([subject(1, untrusted)])).toThrow('Invalid public rating figure');
  }
});

test('hidden, taken-down, redirected and missing subjects delete without any figure data', () => {
  const privateFigure = { ...figure(1), populationId: id(91), voter: id(92) };
  for (const state of [{ visibility: 'hidden' as const }, { visibility: 'taken_down' as const }, { redirect: id(2) }]) {
    expect(build([{ ...subject(1, privateFigure), ...state }])).toEqual([
      { op: 'delete', id: id(1), version: position },
    ]);
  }
  const actions = documentActions({ partition: 10, position, subjects: [] }, [id(1), id(1)]);
  expect(actions).toEqual([{ op: 'delete', id: id(1), version: position }]);
  expect(bulkLines('test-subjects-g1', actions)).toEqual([
    { delete: { _index: 'test-subjects-g1', _id: id(1), version: Number(position), version_type: 'external' } },
  ]);
});

test('public Collection counts coexist with rating fields and restore rebuilds fresh fields at a higher version', () => {
  const current = subject(1, figure(1));
  const actions = documentActions(
    { partition: 10, position, subjects: [current] },
    [id(1), id(1)],
    new Map([[id(1), 6]]),
  );
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({
    document: { public_collection_count: 6, rating_score: 7.625, rating_prior_epoch: 12 },
  });
  const deleted = build([{ ...current, visibility: 'hidden' }], position + 1n);
  expect(deleted).toEqual([{ op: 'delete', id: id(1), version: position + 1n }]);
  for (const publicRating of [undefined, figure(1, { score: null, priorEpoch: null }), figure(1, { score: 0 })]) {
    const restored = build([subject(1, publicRating)], position + 2n);
    expect(restored[0]).toMatchObject({ op: 'index', version: position + 2n });
    const action = restored[0]!;
    if (action.op !== 'index') throw new Error('Expected restored subject');
    if (publicRating === undefined) {
      expect(action.document).not.toHaveProperty('rating_score');
      expect(action.document).not.toHaveProperty('rating_prior_epoch');
    } else {
      expect(action.document).toMatchObject({
        rating_score: publicRating.score,
        rating_prior_epoch: publicRating.priorEpoch,
      });
    }
  }
});

test('new subject mappings bound only raw sort keywords and keep the selected raw label', () => {
  const definition = indices.subjectIndexDefinition() as Definition;
  expect(definition.mappings.properties.id).toEqual({ type: 'keyword', ignore_above: 512 });
  expect(definition.mappings.properties.name_sort).toEqual({
    type: 'keyword',
    normalizer: 'name_key',
    ignore_above: 512,
  });
  expect(definition.mappings.properties.names!.fields).toMatchObject({
    exact: { type: 'keyword', normalizer: 'name_key' },
  });
  expect((definition.mappings.properties.names!.fields as Record<string, object>).exact).not.toHaveProperty(
    'ignore_above',
  );
  expect(MAX_NAME_SORT_CHARACTERS).toBe(512);
  const raw = 'Ａ'.repeat(513);
  const action = build([{ ...subject(1), labels: [{ language: 'en', value: raw }] }])[0]!;
  expect(action).toMatchObject({ document: { name_sort: raw, names: [raw] } });
});

type Definition = {
  settings: unknown;
  mappings: { dynamic: string; properties: Record<string, Record<string, unknown>> };
};
type Mapping = Record<string, { mappings: Definition['mappings'] }>;
type BulkResult = { errors: boolean; items: { index: { status: number; error?: { type: string; reason: string } } }[] };
type Hits = {
  hits: {
    hits: { _id: string; _version: number; fields?: Record<string, unknown>; _source: Record<string, unknown> }[];
  };
};
const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const index = indices.subjectIndexName(prefix, 1);
afterAll(async () => {
  await search.request('DELETE', `/${index}`).catch(() => undefined);
});

test('an old strict generation gains only the two rating mappings with observed native writes', async () => {
  const old = structuredClone(indices.subjectIndexDefinition()) as Definition;
  delete old.mappings.properties.rating_score;
  delete old.mappings.properties.rating_prior_epoch;
  delete old.mappings.properties.name_sort!.ignore_above;
  delete old.mappings.properties.id!.ignore_above;
  await search.request('PUT', `/${index}`, old);
  const before = (await search.request<Mapping>('GET', `/${index}/_mapping`)).body[index]!.mappings;
  expect(
    (await search.bulk<BulkResult>(bulkLines(index, build([subject(1)])), { query: { refresh: 'wait_for' } })).errors,
  ).toBe(false);
  const requests: { method: string; path: string; body: unknown }[] = [];
  const observed: OpenSearch = {
    ...search,
    request(method, path, body, options) {
      requests.push({ method, path, body });
      return search.request(method, path, body, options);
    },
  };
  const properties = {
    rating_score: { type: 'double', doc_values: true, coerce: false },
    rating_prior_epoch: { type: 'long', doc_values: true, coerce: false },
  };
  for (let n = 0; n < 2; n++) {
    await indices.ensureSubjectRatingMapping(observed, prefix, 1);
    expect(requests).toHaveLength((n + 1) * 2);
    expect(requests[n * 2]).toEqual({ method: 'PUT', path: `/${index}/_mapping`, body: { properties } });
    expect(requests[n * 2 + 1]).toEqual({ method: 'GET', path: `/${index}/_mapping`, body: undefined });
  }
  const mapping = (await search.request<Mapping>('GET', `/${index}/_mapping`)).body[index]!.mappings;
  expect(mapping.dynamic).toBe('strict');
  // GET _mapping omits numeric doc_values:true because it equals the native default.
  expect(mapping.properties).toEqual({
    ...before.properties,
    rating_score: { type: 'double', coerce: false },
    rating_prior_epoch: { type: 'long', coerce: false },
  });
  const fields = await search.request<Record<string, { mappings: Record<string, { mapping: unknown }> }>>(
    'GET',
    `/${index}/_mapping/field/rating_score,rating_prior_epoch`,
    undefined,
    { query: { include_defaults: true } },
  );
  for (const [field, expected] of Object.entries(properties)) {
    expect(fields.body[index]!.mappings[field]!.mapping).toMatchObject({ [field]: expected });
  }
  const result = await search.bulk<BulkResult>(
    bulkLines(
      index,
      build([subject(2, figure(2)), subject(3, figure(3, { score: 0 })), subject(4, figure(4, { score: null }))]),
    ),
    { query: { refresh: 'wait_for' } },
  );
  expect(result.errors).toBe(false);
  expect(result.items.map((item) => item.index.status)).toEqual([201, 201, 201]);
  const hits = (
    await search.request<Hits>('POST', `/${index}/_search`, {
      version: true,
      sort: [{ id: 'asc' }],
      docvalue_fields: ['rating_score', 'rating_prior_epoch'],
    })
  ).body.hits.hits;
  expect(hits.map((hit) => hit._version)).toEqual([
    Number(position),
    Number(position),
    Number(position),
    Number(position),
  ]);
  expect(hits.map((hit) => hit.fields?.rating_score ?? [])).toEqual([[], [7.625], [0], []]);
  expect(hits.map((hit) => hit.fields?.rating_prior_epoch ?? [])).toEqual([[], [12], [12], [12]]);
  expect(hits[0]!._source).not.toHaveProperty('rating_score');
  expect(hits[0]!._source).not.toHaveProperty('rating_prior_epoch');
  const deleted = documentActions({ partition: 10, position: position + 1n, subjects: [] }, [id(2), id(3)]);
  expect((await search.bulk<BulkResult>(bulkLines(index, deleted))).errors).toBe(false);
  const restored = build([subject(2), subject(3, figure(3, { score: null, priorEpoch: null }))], position + 2n);
  expect((await search.bulk<BulkResult>(bulkLines(index, restored), { query: { refresh: 'wait_for' } })).errors).toBe(
    false,
  );
  const stale = await search.bulk<BulkResult>(bulkLines(index, build([subject(2, figure(2))])));
  expect(stale.items[0]!.index.status).toBe(409);
  const restoredHits = (
    await search.request<Hits>('POST', `/${index}/_search`, {
      version: true,
      query: { ids: { values: [id(2), id(3)] } },
      sort: [{ id: 'asc' }],
      docvalue_fields: ['rating_score', 'rating_prior_epoch'],
    })
  ).body.hits.hits;
  expect(restoredHits.map((hit) => hit._version)).toEqual([Number(position + 2n), Number(position + 2n)]);
  expect(restoredHits.map((hit) => hit.fields?.rating_score ?? [])).toEqual([[], []]);
  expect(restoredHits.map((hit) => hit.fields?.rating_prior_epoch ?? [])).toEqual([[], []]);
  expect(restoredHits[0]!._source).not.toHaveProperty('rating_score');
  expect(restoredHits[1]!._source.rating_score).toBeNull();
  for (const patch of [
    { rating_score: '7.625' },
    { rating_prior_epoch: '12' },
    { rating_prior_epoch: 12.5 },
    { voter: id(92) },
  ]) {
    const rejected = await search.bulk<BulkResult>([{ index: { _index: index, _id: id(5) } }, { ...patch }]);
    expect(rejected.errors).toBe(true);
    expect(rejected.items[0]!.index.status).toBe(400);
  }
});

test('mapping upgrades validate names and propagate native failures including incompatible mappings', async () => {
  const failure = new OpenSearchError(400, {
    error: { type: 'illegal_argument_exception', reason: 'incompatible rating mapping' },
  });
  let calls = 0;
  const failing: OpenSearch = {
    ...search,
    async request() {
      calls++;
      throw failure;
    },
  };
  await expect(indices.ensureSubjectRatingMapping(failing, prefix, 1)).rejects.toThrow(
    'Subject rating mapping could not be established',
  );
  expect(calls).toBe(2);
  for (const [invalidPrefix, generation] of [
    ['../bad', 1],
    [prefix, 0],
    [prefix, 1.5],
  ] as const) {
    await expect(indices.ensureSubjectRatingMapping(failing, invalidPrefix, generation)).rejects.toBeInstanceOf(
      RangeError,
    );
  }
  expect(calls).toBe(2);
});
