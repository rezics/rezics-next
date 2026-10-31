import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { FilterDocument } from '@rezics/filter';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';
import type { CollectionView, DynamicCollectionView } from '../../../../specs/dynamic-collections-driver.ts';
import type { SearchRequest } from '../../src/search/service.ts';
import type { SearchHit } from '../../src/search/hits.ts';
import type { FacetDiscovery200Response } from '../../src/search/facet-discovery-contract.ts';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerJob,
} from '../../src/search/public-filter-consumer-contract.ts';
import { parseText } from '../../src/search/text.ts';
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
  assert(typeof response.body.code === 'string');
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
      expect(found.map(({ id }) => id)).toEqual([...expected]);
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

test('native private labels do not classify public Books or Recipes or borrow the owners authority', async () => {
  const labels = await population.labels();
  expect(labels.subject.id).toBe(books.subjects['B-long'].id);
  status(await fixture.request('alice', 'GET', `/v1/libraryEntries/${labels.subject.id}`), 404);
  const before = status(labels.publicBefore, 200).body.subject as Subject;
  const after = status(await fixture.read(labels.recipe), 200).body.subject as Subject;
  expect(after.statements[fixture.meaning.diet] ?? []).toEqual([]);
  expect(after).toEqual(before);
  for (const persona of ['anonymous', 'editor', 'alice', 'bob'] as const)
    await pages(persona, { filter: filters.combined, sort: 'id', languages: ['en'] }, ids(['B-long']));
}, 180_000);

// Later finite-population cases also create Books. Restrict these timing controls to
// the original seven native labels, while retaining the actual classification predicate.
const originalBookText = [...positiveNames, ...negativeNames]
  .map((name) => JSON.stringify(`${name} — controlled discovery test case`))
  .join(' | ');
const nativeContext = () => ({ deadline: Date.now() + 60_000 });

async function setOriginalTagHidden(hidden: boolean): Promise<void> {
  const subject = books.subjects['B-long'];
  const fact = books.facts.find((fact) => fact.subject === subject.id && fact.property === 'schema:keywords');
  assert(fact);
  status(
    await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${subject.id}/candidates/${fact.candidate}:${hidden ? 'hide' : 'restore'}`,
      { reason: 'Control current native query privacy at the transport boundary' },
      discoveryKey(),
    ),
    200,
  );
  const read = status(await fixture.read(subject), 200).body.subject as Subject;
  if (hidden) expect(read.statements['schema:keywords'] ?? []).toEqual([]);
  else
    expect(read.statements['schema:keywords']?.map((statement) => statement.value.content)).toContain(
      classification.harem.id,
    );
}

async function setHaremTargetHidden(hidden: boolean): Promise<void> {
  status(
    await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${classification.harem.id}:${hidden ? 'hide' : 'restore'}`,
      { reason: 'Control the actual foreign target without replacing Source authority' },
      discoveryKey(),
    ),
    200,
  );
  status(await fixture.read(classification.harem), hidden ? 404 : 200);
}

async function originalPages(filter: FilterDocument, expected: readonly BookName[]) {
  return pages(
    'anonymous',
    { filter, text: originalBookText, sort: 'id', languages: ['en'], properties: ['schema:keywords'] },
    ids(expected),
  );
}

function capturePlan(filter: FilterDocument): PublicFilterConsumerCaptureInput {
  return { filterDocument: filter, text: parseText(originalBookText), sort: 'id', size: 5, pageSize: 2 };
}

async function capturedNative(plan: PublicFilterConsumerCaptureInput, snapshot: 'pit' | 'prepared') {
  const context = nativeContext();
  const bound = await fixture.search!.bindRequest({ plan, snapshot }, context);
  try {
    let capture = bound.capture;
    while (capture.status === 'preparing') {
      assert(Date.now() < context.deadline, 'The finite native capture did not finish');
      const step = await fixture.search!.repair(capture.repair, context);
      expect(['progress', 'settled'], JSON.stringify(step)).toContain(step.status);
      capture = await bound.operations.capture({ plan, snapshot }, context);
    }
    // An absent Source is a failed required positive, never a readiness success.
    expect(capture.status, JSON.stringify(capture)).toBe('captured');
    assert(capture.status === 'captured');
    expect(capture.queried.snapshot.kind).toBe(snapshot);
    return { operations: bound.operations, capture };
  } catch (error) {
    await bound.operations.close();
    throw error;
  }
}

async function settleNativeRepair(job: PublicFilterConsumerJob): Promise<void> {
  const context = nativeContext();
  for (;;) {
    const step = await fixture.search!.repair(job, context);
    expect(['progress', 'settled'], JSON.stringify(step)).toContain(step.status);
    if (step.status === 'settled') return;
    assert(Date.now() < context.deadline, 'Finite actual local and foreign repair did not settle');
  }
}

function privateReadiness(response: HttpResponse): void {
  preparing(response);
  for (const key of [
    'kinds',
    'labels',
    'facts',
    'cursor',
    'repair',
    'snapshot',
    'queried',
    'execution',
    'observation',
    'job',
  ])
    expect(response.body).not.toHaveProperty(key);
}

test('native correct-password sign-in of the suspended account returns ACCOUNT_SUSPENDED without a session', async () => {
  const response = status(await fixture.signIn('suspended'), 403);
  expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
  for (const key of ['session', 'token', 'access_token', 'refresh_token', 'user'])
    expect(response.body).not.toHaveProperty(key);
  expect(response.headers.get('set-cookie')).toBeNull();
}, 30_000);

for (const reduction of ['local-tag', 'foreign-target'] as const) {
  for (const phase of ['request', 'response'] as const) {
    for (const polarity of ['positive', 'negative'] as const) {
      test(`${reduction} at native ${phase}: ${polarity} HTTP disclosure cannot use the admitted stale engine observation`, async () => {
        await originalPages(harem, positiveNames);
        await originalPages(notHarem, negativeNames);
        await fixture.search!.indexing('paused');
        const barrier = fixture.search!.barrier({
          phase,
          method: 'POST',
          path: '/_search?allow_partial_search_results=false',
        });
        const pending = fixture.request('anonymous', 'POST', '/v1/subjects:search', {
          filter: polarity === 'positive' ? harem : notHarem,
          text: originalBookText,
          sort: 'name',
          limit: 2,
          languages: ['en'],
          properties: ['schema:keywords', fixture.meaning.form],
        });
        // Keep rejection observed even if the timing assertion itself fails.
        const outcome = Promise.allSettled([pending]);
        let reduced = false;
        try {
          await Promise.race([
            barrier.reached,
            outcome.then(() => assert.fail('Native HTTP finished before reaching its actual engine boundary')),
          ]);
          if (reduction === 'local-tag') await setOriginalTagHidden(true);
          else await setHaremTargetHidden(true);
          reduced = true;
          barrier.release();
          privateReadiness(await pending);
          // Editor and owner credentials cannot bypass the public Source observation.
          for (const persona of ['editor', 'alice'] as const)
            privateReadiness(
              await fixture.request(persona, 'POST', '/v1/subjects:search', {
                filter: polarity === 'positive' ? harem : notHarem,
                text: originalBookText,
                sort: 'rating',
                properties: ['schema:keywords'],
              }),
            );
          privateReadiness(
            await fixture.request('anonymous', 'POST', '/v1/subjects:facets', {
              filter: bookType,
              text: originalBookText,
              languages: ['en'],
              facets: [{ property: 'schema:keywords' }],
            }),
          );
          await fixture.search!.indexing('running');
          const positive = reduction === 'local-tag' ? positiveNames.filter((name) => name !== 'B-long') : [];
          const negative =
            reduction === 'local-tag'
              ? ([...negativeNames, 'B-long'] as BookName[])
              : [...positiveNames, ...negativeNames];
          const result = await originalPages(harem, positive);
          for (const hit of result.hits)
            expect(hit.facts?.['schema:keywords']).toEqual([
              {
                kind: 'item',
                id: classification.harem.id,
                labels: { en: 'Bangumi public meta_tags: 后宫 — controlled discovery test case' },
              },
            ]);
          await originalPages(notHarem, negative);
          if (reduction === 'foreign-target')
            expect(await facetPage('anonymous', bookType, 'schema:keywords')).toEqual([]);
        } finally {
          barrier.release();
          await outcome;
          if (reduced) {
            if (reduction === 'local-tag') await setOriginalTagHidden(false);
            else await setHaremTargetHidden(false);
          }
          await fixture.search!.indexing('running');
        }
      }, 240_000);
    }
  }
}

for (const snapshot of ['pit', 'prepared'] as const) {
  test(`${snapshot}: a reduction repaired and ACKed before FINAL still invalidates the original immutable observation`, async () => {
    await originalPages(harem, positiveNames);
    const bound = await capturedNative(capturePlan(harem), snapshot);
    let queried = bound.capture.queried;
    let hidden = false;
    try {
      const query = await bound.operations.query(queried, nativeContext());
      expect(query.status, JSON.stringify(query)).toBe('queried');
      assert(query.status === 'queried');
      queried = query.queried;
      expect(query.result.hits.map(({ id }) => id).sort()).toEqual(ids(positiveNames));
      const clean = await bound.operations.readStatus({ queried, execution: query.execution }, nativeContext());
      expect(clean.status).toBe('observed');
      assert(clean.status === 'observed');
      expect(clean.blocking).toEqual([]);
      await fixture.search!.indexing('paused');
      await setOriginalTagHidden(true);
      hidden = true;
      const pending = await bound.operations.readStatus({ queried, execution: query.execution }, nativeContext());
      expect(pending.status).toBe('observed');
      assert(pending.status === 'observed');
      expect(pending.blocking.length).toBeGreaterThan(0);
      await fixture.search!.indexing('running');
      await settleNativeRepair(bound.capture.repair);
      // A new, complete native result proves that real repair has finished, including
      // dependent visibility. It cannot retroactively authorize the older execution.
      await originalPages(
        harem,
        positiveNames.filter((name) => name !== 'B-long'),
      );
      await originalPages(notHarem, [...negativeNames, 'B-long']);
      const final = await bound.operations.readStatus({ queried, execution: query.execution }, nativeContext());
      expect(final.status).toBe('observed');
      assert(final.status === 'observed');
      expect(final.pending).toEqual([]);
      expect(final.changed.length).toBeGreaterThan(0);
      expect(final.blocking.some(({ phase }) => phase === 'changed')).toBe(true);
      expect(final.queried).toEqual(queried);
      // A later execution must also refuse the old immutable observation, even
      // though the live target has caught up to the relevant reduction.
      const stale = await bound.operations.query(queried, nativeContext());
      expect(stale.status).toBe('preparing');
      expect(stale).not.toHaveProperty('result');
    } finally {
      await bound.operations.closeObservation(queried, nativeContext());
      await bound.operations.close();
      if (hidden) await setOriginalTagHidden(false);
      await fixture.search!.indexing('running');
    }
  }, 240_000);
}

test('late native registration cannot miss a reduction already pending in an excluded original subject', async () => {
  await originalPages(harem, positiveNames);
  await fixture.search!.indexing('paused');
  let hidden = false;
  try {
    await setOriginalTagHidden(true);
    hidden = true;
    // This distinct full AST is first registered AFTER the reduction. The word
    // range alone cannot hide the negative tag dependency on the excluded Book.
    const filter: FilterDocument = { and: [notHarem, filters.words] };
    const plan = capturePlan(filter);
    const bound = await fixture.search!.bindRequest({ plan, snapshot: 'pit' }, nativeContext());
    try {
      if (bound.capture.status === 'captured') {
        const result = await bound.operations.query(bound.capture.queried, nativeContext());
        expect(result.status).toBe('preparing');
        expect(result).not.toHaveProperty('result');
        await bound.operations.closeObservation(bound.capture.queried, nativeContext());
      } else {
        expect(['preparing', 'unready']).toContain(bound.capture.status);
      }
    } finally {
      await bound.operations.close();
    }
    privateReadiness(
      await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        filter,
        text: originalBookText,
        sort: 'id',
        limit: 2,
      }),
    );
    await fixture.search!.indexing('running');
    await originalPages(filter, ['B-long']);
    const repaired = await capturedNative(plan, 'pit');
    try {
      const query = await repaired.operations.query(repaired.capture.queried, nativeContext());
      expect(query.status).toBe('queried');
      assert(query.status === 'queried');
      expect(query.result.hits.map(({ id }) => id)).toEqual(ids(['B-long']));
      expect(query.window.exhausted).toBe(true);
      await repaired.operations.closeObservation(query.queried, nativeContext());
    } finally {
      await repaired.operations.close();
    }
  } finally {
    if (hidden) await setOriginalTagHidden(false);
    await fixture.search!.indexing('running');
  }
}, 240_000);

test('a native sink response lost after refresh-visible writes cannot acknowledge an ambiguous repair', async () => {
  await originalPages(harem, positiveNames);
  const bound = await capturedNative(capturePlan(harem), 'pit');
  let queried = bound.capture.queried;
  let hidden = false;
  const native = fixture.search!;
  await native.indexing('paused');
  const barrier = native.barrier({
    phase: 'response',
    method: 'POST',
    path: '/_bulk?refresh=wait_for',
  });
  let repairing: Promise<Awaited<ReturnType<typeof native.repair>>> | undefined;
  try {
    const query = await bound.operations.query(queried, nativeContext());
    expect(query.status).toBe('queried');
    assert(query.status === 'queried');
    queried = query.queried;
    await setOriginalTagHidden(true);
    hidden = true;
    // Drive only actual repair steps. The response barrier withholds the real
    // sink reply until its native transport deadline, leaving the outcome uncertain.
    repairing = (async () => {
      const context = nativeContext();
      for (;;) {
        const step = await native.repair(bound.capture.repair, context);
        if (step.status !== 'progress') return step;
        assert(Date.now() < context.deadline, 'Repair never dispatched its native sink write');
      }
    })();
    const settled = Promise.allSettled([repairing]);
    await Promise.race([
      barrier.reached,
      settled.then(() => assert.fail('Repair completed before its actual sink response')),
    ]);
    const pending = await bound.operations.readStatus({ queried, execution: query.execution }, nativeContext());
    expect(pending.status).toBe('observed');
    assert(pending.status === 'observed');
    expect(pending.blocking.length).toBeGreaterThan(0);
    privateReadiness(
      await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        filter: notHarem,
        text: originalBookText,
        sort: 'name',
        limit: 2,
      }),
    );
    const uncertain = await repairing;
    expect(['unready', 'unavailable']).toContain(uncertain.status);
    barrier.release();
    const after = await bound.operations.readStatus({ queried, execution: query.execution }, nativeContext());
    expect(after.status).toBe('observed');
    assert(after.status === 'observed');
    expect(after.blocking.length).toBeGreaterThan(0);
    await native.indexing('running');
    await settleNativeRepair(bound.capture.repair);
    await originalPages(
      harem,
      positiveNames.filter((name) => name !== 'B-long'),
    );
    await originalPages(notHarem, [...negativeNames, 'B-long']);
  } finally {
    barrier.release();
    if (repairing) await Promise.allSettled([repairing]);
    await bound.operations.closeObservation(queried, nativeContext());
    await bound.operations.close();
    if (hidden) await setOriginalTagHidden(false);
    await native.indexing('running');
  }
}, 240_000);

test('SIGKILL preserves the same native preparation job expiry prefix and immutable observation across restart', async () => {
  await originalPages(harem, positiveNames);
  const native = fixture.search!;
  expect(native.workerKind).toBe('owned-child');
  const bound = await capturedNative(capturePlan(harem), 'pit');
  let queried = bound.capture.queried;
  let hidden = false;
  let killed = false;
  const barrier = native.barrier({
    phase: 'response',
    method: 'POST',
    path: '/_bulk?refresh=wait_for',
  });
  try {
    const query = await bound.operations.query(queried, nativeContext());
    expect(query.status).toBe('queried');
    assert(query.status === 'queried');
    queried = query.queried;
    await native.indexing('paused');
    await setOriginalTagHidden(true);
    hidden = true;
    // Retain the ACTUAL native job; no caller manufactures a frontier or receipt.
    const id = await native.preparePublic(bound.capture.repair);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        barrier.reached,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The retained native preparation did not reach its sink')), 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const before = await native.readPreparation(id);
    assert(before);
    expect(before.locator).toMatchObject({ kind: 'repair', job: bound.capture.repair });
    const prefix = native.indexPrefix;
    const stats = await native.workerStats();
    expect(await native.crash()).toEqual({ code: null, signal: 'SIGKILL' });
    killed = true;
    barrier.release();
    const retained = await native.readPreparation(id);
    assert(retained);
    expect(retained.id).toBe(before.id);
    expect(retained.locator).toEqual(before.locator);
    expect(retained.expires_at).toBe(before.expires_at);
    expect(BigInt(retained.revision)).toBeGreaterThanOrEqual(BigInt(before.revision));
    const restarted = await native.restart();
    killed = false;
    expect(native.indexPrefix).toBe(prefix);
    expect(restarted.defaultModules).toEqual(stats.defaultModules);
    expect(restarted.registeredModules).toEqual(stats.registeredModules);
    expect(restarted.searchStarterInvocations).toBe(1);
    await settleNativeRepair(bound.capture.repair);
    // Resume the exact retained observation, never capture a new one for recovery.
    const resumed = await native.resumeRequest(queried, nativeContext());
    try {
      const final = await resumed.readStatus({ queried, execution: query.execution }, nativeContext());
      expect(final.status).toBe('observed');
      assert(final.status === 'observed');
      expect(final.queried).toEqual(queried);
      expect(final.blocking.some(({ phase }) => phase === 'changed')).toBe(true);
      const stale = await resumed.query(queried, nativeContext());
      expect(stale.status).toBe('preparing');
      expect(stale).not.toHaveProperty('result');
    } finally {
      await resumed.close();
    }
    await originalPages(
      harem,
      positiveNames.filter((name) => name !== 'B-long'),
    );
    await originalPages(notHarem, [...negativeNames, 'B-long']);
  } finally {
    barrier.release();
    if (killed) await native.restart();
    await bound.operations.closeObservation(queried, nativeContext());
    await bound.operations.close();
    if (hidden) await setOriginalTagHidden(false);
    await native.indexing('running');
  }
}, 240_000);

test('old positive and negative native HTTP cursors remain invalid after the relevant repair has completed', async () => {
  const requests = [harem, notHarem].map((filter) => ({
    filter,
    text: originalBookText,
    sort: 'id' as const,
    limit: 1,
    languages: ['en'],
  }));
  const cursors: string[] = [];
  for (const request of requests) {
    const response = await current('anonymous', '/v1/subjects:search', request);
    countFreeList(response.body);
    expect(response.body.subjects).toHaveLength(1);
    assert(typeof response.body.next === 'string' && response.body.next.length > 0);
    cursors.push(response.body.next);
  }
  let hidden = false;
  await fixture.search!.indexing('paused');
  try {
    await setOriginalTagHidden(true);
    hidden = true;
    await fixture.search!.indexing('running');
    await originalPages(
      harem,
      positiveNames.filter((name) => name !== 'B-long'),
    );
    await originalPages(notHarem, [...negativeNames, 'B-long']);
    for (const [index, request] of requests.entries()) {
      const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        ...request,
        cursor: cursors[index],
      });
      if (response.status === 409) {
        expect(response.body.code).toBe('search_restart_required');
        for (const key of ['subjects', 'next', 'as_of', 'total', 'count', 'observation', 'job'])
          expect(response.body).not.toHaveProperty(key);
      } else privateReadiness(response);
    }
  } finally {
    if (hidden) await setOriginalTagHidden(false);
    await fixture.search!.indexing('running');
  }
}, 240_000);

test('a healthy real adopted word-count edit becomes filterable within the sixty-second catalogue deadline', async () => {
  const marker = `Privacyfresh${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
  const subject = await fixture.createSubject('schema:Book', marker);
  await fixture.catchUp([subject]);
  await pages('anonymous', { text: marker, filter: filters.words, sort: 'id', languages: ['en'] }, []);
  const started = Date.now();
  await fixture.adopt(subject, discoveryStatement(fixture.meaning.words, { amount: 1200001, unit: '1' }));
  // A healthy additive edit may take the documented projection interval. Observe
  // real HTTP membership until it arrives; no acknowledgement substitutes for it.
  for (;;) {
    const response = await current('anonymous', '/v1/subjects:search', {
      text: marker,
      filter: filters.words,
      sort: 'id',
      limit: 2,
      languages: ['en'],
    });
    countFreeList(response.body);
    const found = (response.body.subjects as SearchHit[]).map(({ id }) => id);
    expect(response.body.next).toBeNull();
    if (found.length > 0) {
      expect(found).toEqual([subject.id]);
      break;
    }
    expect(found).toEqual([]);
    assert(Date.now() - started < 60_000, 'The real adopted word-count edit missed its searchable deadline');
    await Bun.sleep(25);
  }
  const result = await pages(
    'anonymous',
    { text: marker, filter: filters.words, sort: 'id', languages: ['en'], properties: [fixture.meaning.words] },
    [subject.id],
  );
  expect(Date.now() - started).toBeLessThanOrEqual(60_000);
  expect(result.hits[0]!.facts).toEqual({
    [fixture.meaning.words]: [{ kind: 'quantity', amount: 1200001, unit: '1' }],
  });
}, 120_000);

function collectionPrivacyPath(collectionId: string, filter: FilterDocument, cursor?: string): string {
  const query = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: '2' });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/v1/collections/${collectionId}/members?${query}`;
}

function collectionReadiness(response: HttpResponse): void {
  if (response.status === 503) privateReadiness(response);
  else {
    status(response, 202);
    expect(response.body).toEqual({ preparing: true });
    expect(response.headers.get('retry-after')).toBeTruthy();
  }
  expect(response.headers.get('cache-control')).toContain('private');
  expect(response.headers.get('cache-control')).toContain('no-store');
}

async function collectionPrivacyPages(
  persona: DiscoveryPersona,
  collectionId: string,
  filter: FilterDocument,
  expected: readonly string[],
): Promise<void> {
  const found: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const deadline = Date.now() + 60_000;
  for (let page = 0; page < Math.max(1, Math.ceil(expected.length / 2)); page++) {
    let response: HttpResponse;
    for (;;) {
      response = await fixture.request(persona, 'GET', collectionPrivacyPath(collectionId, filter, cursor));
      if (response.status === 200) break;
      collectionReadiness(response);
      assert(Date.now() < deadline, 'The finite native Collection result did not finish preparation');
      await Bun.sleep(25);
    }
    countFreeList(response.body);
    expect(Object.keys(response.body).sort()).toEqual(['members', 'next']);
    assert(Array.isArray(response.body.members));
    const rows = response.body.members as { subjectId: string }[];
    expect(rows.map(({ subjectId }) => subjectId)).toEqual(expected.slice(page * 2, page * 2 + 2));
    found.push(...rows.map(({ subjectId }) => subjectId));
    expect(new Set(found).size).toBe(found.length);
    if (response.body.next === null) {
      expect(found).toEqual([...expected]);
      return;
    }
    expect(rows).toHaveLength(2);
    assert(typeof response.body.next === 'string' && response.body.next.length > 0);
    expect(cursors.has(response.body.next)).toBe(false);
    cursor = response.body.next;
    cursors.add(cursor);
  }
  assert.fail('Native Collection cursor did not exhaust within the exact useful-page bound');
}

for (const surface of ['public-curated', 'own-everything-without-state', 'own-state'] as const) {
  test(`${surface}: native positive and NOT harem withhold stale membership until current repair`, async () => {
    await fixture.setup.openFeatures(['reading_progress']);
    const sources = await population.sources();
    let collectionId: string;
    if (surface === 'public-curated') {
      const source = sources.sources.find(({ source }) => source.visibility === 'public');
      assert(source);
      collectionId = source.source.id;
    } else {
      const accepted = population.profile('schema:Book');
      const set = accepted.profile.entryStateSet;
      assert(set);
      const active = set.states.find(({ role }) => role === 'active');
      assert(active);
      if (surface === 'own-everything-without-state') {
        status(await fixture.request('alice', 'GET', `/v1/libraryEntries/${books.subjects['B-long'].id}`), 404);
      } else {
        const written = status(
          await fixture.request(
            'alice',
            'PUT',
            `/v1/libraryEntries/${books.subjects['B-long'].id}`,
            { state: active.id },
            discoveryKey(),
          ),
          201,
        );
        expect(
          status(await fixture.request('alice', 'GET', `/v1/libraryEntries/${books.subjects['B-long'].id}`), 200).body,
        ).toEqual(written.body);
      }
      const response = status(
        await fixture.request(
          'alice',
          'GET',
          `/v1/collections?curatorAccountId=${fixture.personas.alice.accountId}&limit=100`,
        ),
        200,
      );
      expect(response.body.next).toBeNull();
      const rows = response.body.collections as CollectionView[];
      const views = rows.filter(
        (row): row is DynamicCollectionView =>
          row.membershipKind === 'dynamic' &&
          (surface === 'own-everything-without-state'
            ? row.builtinKind === 'everything'
            : row.builtin?.kind === 'state' &&
              row.builtin.profileId === accepted.profile.id &&
              row.builtin.stateSetId === set.id &&
              row.builtin.stateId === active.id),
      );
      expect(views).toHaveLength(1);
      collectionId = views[0]!.id;
      for (const persona of ['anonymous', 'bob'] as const)
        status(await fixture.request(persona, 'GET', collectionPrivacyPath(collectionId, filters.combined)), 404);
    }
    // The true word predicate restricts this shared population to the actual B-long.
    // The NOT control therefore tests a subject originally EXCLUDED by its public tag.
    const positive: FilterDocument = { and: [harem, filters.words] };
    const negative: FilterDocument = { and: [notHarem, filters.words] };
    const personas = surface === 'public-curated' ? (['anonymous', 'editor', 'alice'] as const) : (['alice'] as const);
    for (const persona of personas) {
      await collectionPrivacyPages(persona, collectionId, positive, ids(['B-long']));
      await collectionPrivacyPages(persona, collectionId, negative, []);
    }
    await fixture.search!.indexing('paused');
    let hidden = false;
    try {
      await setOriginalTagHidden(true);
      hidden = true;
      for (const persona of personas)
        for (const filter of [positive, negative])
          collectionReadiness(await fixture.request(persona, 'GET', collectionPrivacyPath(collectionId, filter)));
      await fixture.search!.indexing('running');
      for (const persona of personas) {
        await collectionPrivacyPages(persona, collectionId, positive, []);
        await collectionPrivacyPages(persona, collectionId, negative, ids(['B-long']));
      }
    } finally {
      if (hidden) await setOriginalTagHidden(false);
      await fixture.search!.indexing('running');
    }
  }, 240_000);
}

// Surface applicability stays explicit: catalogue Search/facets and common curated,
// Everything and state Collection transports are exercised above. Mounted Zone and
// configured TypeList privacy still require the shared fixture's real publication,
// mount and page-definition handles; population.prerequisites.publishedDynamicAndZone
// is descriptive, not such a constructor. Subject detail is factual projection,
// not an invented seventh filter endpoint. Original hidden/terminal and codec suites
// remain independently required. No absent owner-query or Source-control wire is sent.
