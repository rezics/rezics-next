import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { FilterDocument } from '@rezics/filter';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';
import type { SearchRequest } from '../../src/search/service.ts';
import type { SearchHit } from '../../src/search/hits.ts';
import type { FacetDiscovery200Response } from '../../src/search/facet-discovery-contract.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  discoveryKey,
  discoveryStatement,
  type BookName,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import {
  createReleasedLibraryPopulation,
  type ReleasedLibraryPopulation,
} from '../library/support/released-library-population.ts';

let population: ReleasedLibraryPopulation;
let fixture: ReleasedDiscoveryFixture;
let books: Awaited<ReturnType<ReleasedDiscoveryFixture['books']>>;
let classification: Awaited<ReturnType<ReleasedDiscoveryFixture['classification']>>;
let filters: ReturnType<ReleasedDiscoveryFixture['filters']>;
let harem: FilterDocument;
let notHarem: FilterDocument;
const bookType: FilterDocument = { type: { in: ['schema:Book'] } };
const positiveNames: BookName[] = ['B-long', 'B-edge', 'B-unknown', 'B-characters', 'B-tag-only'];
const negativeNames: BookName[] = ['B-short', 'B-form-only'];
const formNames: BookName[] = ['B-long', 'B-edge', 'B-characters'];

beforeAll(async () => {
  // The current Commerce constructor forwards native Search options to its sole released base.
  population = await createReleasedLibraryPopulation({ version: 1, search: 'native' });
  fixture = population.base;
  expect(fixture.version).toBe(1);
  expect(fixture.release.digest).toBe(bundledDigest);
  assert(fixture.search);
  await fixture.setup.openFeatures(['search', 'search_advanced', 'personal_library']);
  await fixture.grant('editor', ['moderation:hide', 'moderation:restore'], GLOBAL_CONTEXT);
  classification = await fixture.classification();
  books = await fixture.books();
  filters = fixture.filters(classification, await fixture.diet());
  const tag: FilterDocument = { statement: { property: 'schema:keywords', in: [classification.harem.id] } };
  harem = { and: [bookType, tag] };
  notHarem = { and: [bookType, { not: tag }] };
}, 120_000);

afterAll(async () => {
  if (population) await population.close();
}, 180_000);

function status(response: HttpResponse, expected: number): HttpResponse {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response;
}

function countFreeList(body: Record<string, unknown>): void {
  // Public rating figures retain their independently owned voter count. List totals do not.
  for (const key of ['total', 'totals', 'count', 'estimate', 'relation', 'observation', 'execution', 'job'])
    expect(body).not.toHaveProperty(key);
  if (body.kinds) {
    const kinds = body.kinds as { values: Record<string, unknown>[] };
    for (const value of kinds.values) {
      expect(value).not.toHaveProperty('count');
      expect(value).not.toHaveProperty('total');
    }
  }
}

function preparing(response: HttpResponse): void {
  status(response, 503);
  expect(response.body.status).toBe(503);
  expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
  expect(response.headers.get('retry-after')).toBeTruthy();
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  for (const key of ['subjects', 'facets', 'next', 'total', 'count', 'as_of'])
    expect(response.body).not.toHaveProperty(key);
}

async function current(
  persona: DiscoveryPersona,
  path: '/v1/subjects:search' | '/v1/subjects:facets',
  body: unknown,
): Promise<HttpResponse> {
  // A finite native population must finish preparation. Readiness is never a passing positive.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fixture.request(persona, 'POST', path, body);
    if (response.status === 200) return response;
    preparing(response);
    assert(Date.now() < deadline, `Native finite preparation did not finish: ${JSON.stringify(response.body)}`);
    await Bun.sleep(25);
  }
}

function ids(names: readonly BookName[]): string[] {
  return names.map((name) => books.subjects[name].id).sort();
}

async function pages(persona: DiscoveryPersona, request: SearchRequest, expected: readonly string[]) {
  const limit = request.limit ?? 2;
  const found: SearchHit[] = [];
  const lengths: number[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  // This bound follows the fixed expected population and page size, not the indexed source size.
  const maximum = Math.max(1, Math.ceil(expected.length / limit));
  for (let page = 0; page < maximum; page++) {
    const response = await current(persona, '/v1/subjects:search', {
      ...request,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    countFreeList(response.body);
    assert(typeof response.body.as_of === 'string');
    expect(Number.isFinite(Date.parse(response.body.as_of))).toBe(true);
    assert(Array.isArray(response.body.subjects));
    assert(response.body.next === null || (typeof response.body.next === 'string' && response.body.next.length > 0));
    const hits = response.body.subjects as SearchHit[];
    expect(hits.length).toBeLessThanOrEqual(limit);
    if (response.body.next !== null) expect(hits).toHaveLength(limit);
    for (const hit of hits) {
      expect(hit.type).toBe('schema:Book');
      expect(Object.keys(hit.labels)).toEqual(['en']);
      expect(hit.labels.en).toBeTruthy();
    }
    found.push(...hits);
    lengths.push(hits.length);
    expect(new Set(found.map(({ id }) => id)).size).toBe(found.length);
    expect(found.length).toBeLessThanOrEqual(expected.length);
    if (response.body.next === null) {
      expect(found.map(({ id }) => id)).toEqual(expected);
      return { hits: found, lengths };
    }
    cursor = response.body.next;
    expect(seen.has(cursor)).toBe(false);
    seen.add(cursor);
  }
  assert.fail('A fixed native result did not reach genuine exhaustion within its exact page bound');
}

async function facetPage(persona: DiscoveryPersona, filter: FilterDocument, property: string) {
  const response = await current(persona, '/v1/subjects:facets', {
    filter,
    languages: ['en'],
    facets: [{ property, size: 2 }],
  });
  countFreeList(response.body);
  expect(Object.keys(response.body).sort()).toEqual(['as_of', 'facets']);
  const body = response.body as FacetDiscovery200Response;
  expect(body.facets).toHaveLength(1);
  const facet = body.facets[0]!;
  expect(Object.keys(facet).sort()).toEqual(['next', 'property', 'values']);
  expect(facet.property).toBe(property);
  expect(facet.next).toBeNull();
  for (const value of facet.values) {
    expect(Object.keys(value).sort()).toEqual(['labels', 'value']);
    expect(Object.keys(value.labels)).toEqual(['en']);
    expect(value.labels.en).toBeTruthy();
  }
  return facet.values;
}

for (const persona of ['anonymous', 'editor', 'alice'] as const) {
  test(`${persona}: native public harem membership includes all five released tagged books`, async () => {
    await pages(persona, { filter: harem, sort: 'id', languages: ['en'] }, ids(positiveNames));
  }, 90_000);

  test(`${persona}: native NOT harem checks the excluded books and exhausts the exact public complement`, async () => {
    const result = await pages(persona, { filter: notHarem, sort: 'id', languages: ['en'] }, ids(negativeNames));
    for (const excluded of ids(positiveNames)) expect(result.hits.map(({ id }) => id)).not.toContain(excluded);
  }, 90_000);
}

test('native released light-novel harem word-count intersection excludes equality absent words and edition pages', async () => {
  await pages('anonymous', { filter: filters.combined, sort: 'id', languages: ['en'] }, ids(['B-long']));
}, 90_000);

test('native name order fills two useful pages in comparator order without repeating a canonical book', async () => {
  const result = await pages(
    'anonymous',
    { filter: filters.formHarem, sort: 'name', languages: ['en'] },
    ['B-characters', 'B-edge', 'B-long'].map((name) => books.subjects[name as BookName].id),
  );
  expect(result.lengths).toEqual([2, 1]);
}, 90_000);

test('native requested fields retain actual labelled Concepts and genuine word units for public and editor reads', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    const result = await pages(
      persona,
      {
        filter: filters.combined,
        sort: 'id',
        languages: ['en'],
        properties: [fixture.meaning.form, 'schema:keywords', fixture.meaning.words],
      },
      ids(['B-long']),
    );
    expect(result.hits[0]!.facts).toEqual({
      [fixture.meaning.form]: [
        {
          kind: 'item',
          id: classification.lightNovel.id,
          labels: { en: 'Light novel — controlled discovery test case' },
        },
      ],
      'schema:keywords': [
        {
          kind: 'item',
          id: classification.harem.id,
          labels: { en: 'Bangumi public meta_tags: 后宫 — controlled discovery test case' },
        },
      ],
      [fixture.meaning.words]: [{ kind: 'quantity', amount: 1200001, unit: '1' }],
    });
  }
}, 90_000);

test('native harem and light-novel facets disclose the released labels without sampled counts', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    expect(await facetPage(persona, filters.formHarem, 'schema:keywords')).toEqual([
      {
        value: classification.harem.id,
        labels: { en: 'Bangumi public meta_tags: 后宫 — controlled discovery test case' },
      },
    ]);
    expect(await facetPage(persona, filters.formHarem, fixture.meaning.form)).toEqual([
      { value: classification.lightNovel.id, labels: { en: 'Light novel — controlled discovery test case' } },
    ]);
  }
}, 150_000);

test('native rating ordering also omits query totals and keeps the original null-rating ID tie order', async () => {
  await pages('anonymous', { filter: filters.formHarem, sort: 'rating', languages: ['en'] }, ids(formNames));
}, 90_000);

test('native private labels do not classify public Books or Recipes or borrow the owners authority', async () => {
  const labels = await population.labels();
  expect(labels.subject.id).toBe(books.subjects['B-long'].id);
  status(await fixture.request('alice', 'GET', `/v1/libraryEntries/${labels.subject.id}`), 404);
  const before = status(labels.publicBefore, 200).body.subject as Subject;
  const after = status(await fixture.read(labels.recipe), 200).body.subject as Subject;
  expect(after.statements[fixture.meaning.diet] ?? []).toEqual([]);
  expect(after).toEqual(before);
  for (const persona of ['anonymous', 'editor', 'alice', 'bob'] as const)
    await pages(persona, { filter: harem, sort: 'id', languages: ['en'] }, ids(positiveNames));
}, 180_000);

test('native unscoped credentials are denied instead of being downgraded to an anonymous catalogue read', async () => {
  for (const [path, body] of [
    ['/v1/subjects:search', { filter: harem }],
    ['/v1/subjects:facets', { filter: harem, facets: [{ property: 'schema:keywords' }] }],
  ] as const) {
    const response = status(await fixture.request('unscoped', 'POST', path, body), 403);
    expect(response.body.code).toBe('insufficient_scope');
    expect(response.body).not.toHaveProperty('subjects');
    expect(response.body).not.toHaveProperty('facets');
  }
}, 30_000);

test('native pre-suspension revoked bearer returns invalid_credentials with the invalid_token challenge', async () => {
  for (const [method, path, body] of [
    ['POST', '/v1/subjects:search', { filter: harem }],
    ['POST', '/v1/subjects:facets', { filter: harem, facets: [{ property: 'schema:keywords' }] }],
    ['GET', '/v1/subjects:suggest?q=Book', undefined],
  ] as const) {
    const response = status(await fixture.request('suspended', method, path, body), 401);
    expect(response.body).toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body).not.toHaveProperty('subjects');
    expect(response.body).not.toHaveProperty('facets');
  }
}, 30_000);

test('withholding a real harem candidate while Search is paused blocks positive negative order fields and facets', async () => {
  const subject = books.subjects['B-long'];
  const fact = books.facts.find((fact) => fact.subject === subject.id && fact.property === 'schema:keywords');
  assert(fact);
  await pages('anonymous', { filter: harem, sort: 'id', languages: ['en'] }, ids(positiveNames));
  await pages('anonymous', { filter: notHarem, sort: 'id', languages: ['en'] }, ids(negativeNames));
  await fixture.search!.indexing('paused');
  let hidden = false;
  try {
    status(
      await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${subject.id}/candidates/${fact.candidate}:hide`,
        { reason: 'Withhold the admitted public harem evidence' },
        discoveryKey(),
      ),
      200,
    );
    hidden = true;
    const readable = status(await fixture.read(subject), 200).body.subject as Subject;
    expect(readable.statements['schema:keywords'] ?? []).toEqual([]);
    for (const persona of ['anonymous', 'editor', 'alice'] as const) {
      for (const request of [
        { filter: harem, sort: 'id' },
        { filter: notHarem, sort: 'id' },
        { filter: notHarem, sort: 'name', properties: ['schema:keywords'] },
        { filter: notHarem, sort: 'rating' },
        { filter: bookType, text: JSON.stringify('B-long — controlled discovery test case'), sort: 'name' },
      ] satisfies SearchRequest[])
        preparing(await fixture.request(persona, 'POST', '/v1/subjects:search', request));
      preparing(
        await fixture.request(persona, 'POST', '/v1/subjects:facets', {
          filter: bookType,
          facets: [{ property: 'schema:keywords' }],
        }),
      );
    }
    await fixture.search!.indexing('running');
    await pages(
      'anonymous',
      { filter: harem, sort: 'id', languages: ['en'] },
      ids(positiveNames.filter((name) => name !== 'B-long')),
    );
    await pages('anonymous', { filter: notHarem, sort: 'id', languages: ['en'] }, ids([...negativeNames, 'B-long']));
  } finally {
    if (hidden)
      status(
        await fixture.request(
          'editor',
          'POST',
          `/v1/subjects/${subject.id}/candidates/${fact.candidate}:restore`,
          { reason: 'Restore the controlled public candidate' },
          discoveryKey(),
        ),
        200,
      );
    await fixture.search!.indexing('running');
  }
}, 240_000);

test('hiding the actual harem target waits for dependent repair and then returns the exact current complement', async () => {
  await pages('anonymous', { filter: harem, sort: 'id', languages: ['en'] }, ids(positiveNames));
  await fixture.search!.indexing('paused');
  let hidden = false;
  try {
    status(
      await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${classification.harem.id}:hide`,
        { reason: 'Remove the actual foreign classification target' },
        discoveryKey(),
      ),
      200,
    );
    hidden = true;
    status(await fixture.read(classification.harem), 404);
    for (const persona of ['anonymous', 'editor', 'alice'] as const) {
      for (const filter of [harem, notHarem])
        preparing(await fixture.request(persona, 'POST', '/v1/subjects:search', { filter, sort: 'name', limit: 2 }));
      preparing(
        await fixture.request(persona, 'POST', '/v1/subjects:facets', {
          filter: bookType,
          facets: [{ property: 'schema:keywords' }],
        }),
      );
    }
    await fixture.search!.indexing('running');
    await pages('anonymous', { filter: harem, sort: 'id', languages: ['en'] }, []);
    await pages(
      'anonymous',
      { filter: notHarem, sort: 'id', languages: ['en'] },
      Object.values(books.subjects)
        .map(({ id }) => id)
        .sort(),
    );
    expect(await facetPage('anonymous', bookType, 'schema:keywords')).toEqual([]);
  } finally {
    if (hidden)
      status(
        await fixture.request(
          'editor',
          'POST',
          `/v1/subjects/${classification.harem.id}:restore`,
          { reason: 'Restore the controlled classification target' },
          discoveryKey(),
        ),
        200,
      );
    await fixture.search!.indexing('running');
  }
}, 240_000);

test('a relevant withheld tag invalidates both positive and excluded-subject continuations', async () => {
  const requests: SearchRequest[] = [
    { filter: harem, sort: 'id', limit: 1, languages: ['en'] },
    { filter: notHarem, sort: 'name', limit: 1, languages: ['en'] },
  ];
  const cursors: string[] = [];
  for (const request of requests) {
    const first = await current('anonymous', '/v1/subjects:search', request);
    countFreeList(first.body);
    assert(Array.isArray(first.body.subjects));
    expect(first.body.subjects).toHaveLength(1);
    assert(typeof first.body.next === 'string' && first.body.next.length > 0);
    cursors.push(first.body.next);
  }
  const subject = books.subjects['B-long'];
  const fact = books.facts.find((fact) => fact.subject === subject.id && fact.property === 'schema:keywords');
  assert(fact);
  await fixture.search!.indexing('paused');
  let hidden = false;
  try {
    status(
      await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${subject.id}/candidates/${fact.candidate}:hide`,
        { reason: 'Invalidate observations that included or excluded this book' },
        discoveryKey(),
      ),
      200,
    );
    hidden = true;
    for (const persona of ['anonymous', 'editor'] as const) {
      for (let index = 0; index < requests.length; index++) {
        const response = await fixture.request(persona, 'POST', '/v1/subjects:search', {
          ...requests[index],
          cursor: cursors[index],
        });
        if (response.status === 409) {
          expect(response.body.code).toBe('search_restart_required');
          for (const key of ['subjects', 'next', 'total', 'count']) expect(response.body).not.toHaveProperty(key);
        } else preparing(response);
      }
    }
    await fixture.search!.indexing('running');
    await pages(
      'anonymous',
      { filter: harem, sort: 'id', languages: ['en'] },
      ids(positiveNames.filter((name) => name !== 'B-long')),
    );
    await pages('anonymous', { filter: notHarem, sort: 'id', languages: ['en'] }, ids([...negativeNames, 'B-long']));
  } finally {
    if (hidden)
      status(
        await fixture.request(
          'editor',
          'POST',
          `/v1/subjects/${subject.id}/candidates/${fact.candidate}:restore`,
          { reason: 'Restore the controlled continuation witness' },
          discoveryKey(),
        ),
        200,
      );
    await fixture.search!.indexing('running');
  }
}, 240_000);

test('finite sparse native input finishes preparation with full and exhausted useful pages', async () => {
  const marker = `Privacyfinite${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
  const expected: string[] = [];
  const created = [];
  for (let index = 0; index < 19; index++) {
    const book = await fixture.createSubject('schema:Book', `${marker} ${String(index).padStart(2, '0')}`);
    created.push(book);
    if (index >= 16) {
      await fixture.adopt(book, discoveryStatement('schema:keywords', classification.harem.id));
      expected.push(book.id);
    }
  }
  await fixture.catchUp(created);
  const result = await pages(
    'anonymous',
    { text: marker, filter: harem, sort: 'id', languages: ['en'] },
    expected.sort(),
  );
  expect(result.lengths).toEqual([2, 1]);
}, 180_000);
