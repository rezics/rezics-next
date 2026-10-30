import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { facetProperties, validateFilter, type FilterDocument } from '@rezics/filter';
import { PROFILE_FORMAT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import type { FacetDiscoveryRequest, FacetDiscovery200Response } from '../../src/search/facet-discovery-contract.ts';

let fixture: ReleasedDiscoveryFixture;
let books: Awaited<ReturnType<ReleasedDiscoveryFixture['books']>>;
let recipes: Awaited<ReturnType<ReleasedDiscoveryFixture['recipes']>>;
let filters: ReturnType<ReleasedDiscoveryFixture['filters']>;
const marker = `Catalogue${crypto.randomUUID().replaceAll('-', '')}`;
const entries: { tag: CreatedSubject; books: CreatedSubject[] }[] = [];
const bookFilter: FilterDocument = { type: { in: ['schema:Book'] } };

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  expect(fixture.version).toBe(1);
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(fixture.release.definition).toEqual(bundledRelease);
  expect(fixture.release.activeHead).toBeGreaterThan(0);
  assert(fixture.search);
  await fixture.setup.openFeatures(['search', 'search_advanced']);
  books = await fixture.books();
  recipes = await fixture.recipes();
  filters = fixture.filters(await fixture.classification(), await fixture.diet());
  const scheme = await fixture.createSubject('skos:ConceptScheme', `${marker} keywords`);
  for (let index = 0; index < 21; index++) {
    const tag = await fixture.createSubject('skos:Concept', `Keyword ${21 - index}`);
    await fixture.adopt(tag, discoveryStatement('skos:inScheme', scheme.id));
    const tagged: CreatedSubject[] = [];
    for (let copy = 0; copy < (index < 5 ? 2 : 1); copy++) {
      const book = await fixture.createSubject('schema:Book', `${marker} ${index} ${copy}`);
      await fixture.adopt(book, discoveryStatement('schema:keywords', tag.id));
      tagged.push(book);
    }
    entries.push({ tag, books: tagged });
  }
  await fixture.catchUp([scheme, ...entries.flatMap(({ tag, books }) => [tag, ...books])]);
}, 120_000);

afterAll(async () => {
  if (fixture) await fixture.close();
}, 180_000);

/** Inspect the actual count-free wire, without normalizing producer data into an expected result. */
function noCounts(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(['count', 'total', 'relation', 'estimate']).not.toContain(key);
    noCounts(child);
  }
}

async function catalogue(persona: DiscoveryPersona, filter: FilterDocument) {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await fixture.request(persona, 'POST', '/v1/subjects:search', {
      filter,
      sort: 'id',
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    noCounts(response.body);
    assert(Array.isArray(response.body.subjects));
    assert(response.body.next === null || typeof response.body.next === 'string');
    const subjects = response.body.subjects as { id: string }[];
    if (response.body.next !== null) expect(subjects).toHaveLength(2);
    expect(subjects.length).toBeLessThanOrEqual(2);
    ids.push(...subjects.map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    cursor = response.body.next ?? undefined;
    if (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
    expect(ids.length).toBeLessThanOrEqual(26);
  } while (cursor);
  expect(ids).toEqual([...ids].sort());
  return ids;
}

for (const persona of ['anonymous', 'editor'] as const) {
  test(`${persona}: released word-count catalogue returns exactly B-long`, async () => {
    expect(await catalogue(persona, filters.words)).toEqual([books.subjects['B-long'].id]);
  }, 60_000);
  test(`${persona}: released light-novel form and harem keyword return the exact three books`, async () => {
    expect(await catalogue(persona, filters.formHarem)).toEqual(
      ['B-long', 'B-edge', 'B-characters'].map((name) => books.subjects[name as keyof typeof books.subjects].id).sort(),
    );
  }, 60_000);
  test(`${persona}: combined word-count, form and harem catalogue returns exactly B-long`, async () => {
    expect(await catalogue(persona, filters.combined)).toEqual([books.subjects['B-long'].id]);
  }, 60_000);
  test(`${persona}: released vegetarian recipes within thirty minutes return the exact four recipes`, async () => {
    expect(await catalogue(persona, filters.dietTime)).toEqual(
      ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked']
        .map((name) => recipes.subjects[name as keyof typeof recipes.subjects].id)
        .sort(),
    );
  }, 60_000);
}

async function facets(
  request: FacetDiscoveryRequest,
  persona: DiscoveryPersona = 'anonymous',
): Promise<FacetDiscovery200Response> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.request(persona, 'POST', '/v1/subjects:facets', request);
    if (response.status === 200) {
      expect(Object.keys(response.body).sort()).toEqual(['as_of', 'facets']);
      noCounts(response.body);
      assert(Array.isArray(response.body.facets));
      for (const facet of response.body.facets) {
        expect(Object.keys(facet).sort()).toEqual(['next', 'property', 'values']);
        assert(facet.next === null || (typeof facet.next === 'string' && facet.next.length > 0));
        for (const value of facet.values) expect(Object.keys(value).sort()).toEqual(['labels', 'value']);
      }
      return response.body as FacetDiscovery200Response;
    }
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    assert(typeof response.body.code === 'string');
    expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
    expect(response.headers.get('retry-after')).toBeTruthy();
    if (Date.now() >= deadline)
      throw new Error(`Native facet preparation did not finish: ${JSON.stringify(response.body)}`);
    await Bun.sleep(25);
  }
}

test('every eligible native keyword is reachable through count-free continuation and refines actual books', async () => {
  for (const size of [2, undefined, 20]) {
    const values: string[] = [];
    const lengths: number[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await facets({
        text: marker,
        filter: bookFilter,
        languages: ['en'],
        facets: [
          {
            property: 'schema:keywords',
            ...(size === undefined ? {} : { size }),
            ...(cursor ? { cursor } : {}),
          },
        ],
      });
      expect(response.facets).toHaveLength(1);
      const facet = response.facets[0]!;
      expect(facet.property).toBe('schema:keywords');
      expect(facet.values.length).toBeGreaterThan(0);
      if (facet.next !== null) expect(facet.values).toHaveLength(size ?? 10);
      lengths.push(facet.values.length);
      for (const value of facet.values) {
        expect(Object.values(value.labels).some((label) => label.includes('Keyword'))).toBe(true);
        values.push(value.value);
      }
      expect(new Set(values).size).toBe(values.length);
      expect(values.length).toBeLessThanOrEqual(21);
      cursor = facet.next ?? undefined;
      if (cursor) {
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
      }
    } while (cursor);
    expect(lengths).toEqual(
      size === 2 ? [...Array.from({ length: 10 }, () => 2), 1] : size === 20 ? [20, 1] : [10, 10, 1],
    );
    expect(values).toEqual(entries.map(({ tag }) => tag.id).sort());
  }
  for (const entry of entries)
    expect(
      await catalogue('anonymous', {
        and: [
          bookFilter,
          {
            statement: { property: 'schema:keywords', in: [entry.tag.id] },
          },
        ],
      }),
    ).toEqual(entry.books.map(({ id }) => id).sort());
}, 60_000);

test('the full released property roster is available, including sixteen Movie fields and independent ranges', async () => {
  const movie = await fixture.createSubject('schema:Movie', `${marker} movie`);
  await fixture.catchUp([movie]);
  const release = fixture.release.definition;
  for (const type of ['schema:Book', 'schema:Recipe', 'schema:Movie']) {
    const definition = release.types[type]!;
    const expected = [
      ...new Set([
        ...(definition.facets ?? []),
        ...definition.bases.flatMap((base) => release.types[base]?.facets ?? []),
      ]),
    ];
    const roster = facetProperties(release, [type]);
    expect(roster).toEqual(expected);
    if (type === 'schema:Movie') expect(roster).toHaveLength(16);
    const enumerable: string[] = [];
    for (const property of roster) {
      const field = release.properties[property]!;
      if (field.datatype === 'wikibase-item' || field.datatype === 'string') enumerable.push(property);
      else {
        const range = {
          gte: field.datatype === 'time' ? 2020 : 1,
          ...(field.datatype === 'quantity' ? { unit: field.units![0]! } : {}),
        };
        const filter: FilterDocument = { and: [{ type: { in: [type] } }, { statement: { property, range } }] };
        expect(validateFilter(filter, release)).toEqual([]);
        const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
          filter,
          sort: 'id',
          limit: 2,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        noCounts(response.body);
      }
    }
    for (let offset = 0; offset < enumerable.length; offset += 8) {
      const properties = enumerable.slice(offset, offset + 8);
      const result = await facets({
        filter: { type: { in: [type] } },
        facets: properties.map((property) => ({ property })),
      });
      expect(result.facets.map(({ property }) => property)).toEqual(properties);
    }
  }
}, 60_000);

test('actual suspended pre-deletion credentials answer the existing native revoked-bearer challenge', async () => {
  for (const [method, path, body] of [
    ['POST', '/v1/subjects:search', { filter: bookFilter }],
    ['GET', '/v1/subjects:suggest?q=Book', undefined],
    ['POST', '/v1/subjects:facets', { filter: bookFilter, facets: [{ property: 'schema:keywords' }] }],
  ] as const) {
    const response = await fixture.request('suspended', method, path, body);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('invalid_credentials');
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  }
});

test('configured TypeList uses real native aggregate continuation beyond twenty-four and retains sibling independence', async () => {
  const filter = { statement: { property: 'schema:keywords', in: entries.map(({ tag }) => tag.id) } };
  const document: CompositionDocument = {
    root: { props: {} },
    content: ['catalogue', 'sibling'].map((id) => ({
      type: 'TypeList',
      props: { id, title: { en: 'Selected books' }, types: ['schema:Book'], sort: 'name', limit: 24, filter },
    })),
  };
  await fixture.grant(
    'steward',
    ['presentation:publish', 'presentation:activate'],
    '00000000-0000-8000-8000-000000000000',
  );
  const published = await fixture.request(
    'steward',
    'POST',
    '/v1/presentation/profiles',
    {
      profile: {
        format: PROFILE_FORMAT,
        generic: document,
        bases: [],
        types: [],
        routes: [{ route: '/selected-books', document }],
      },
    },
    discoveryKey(),
  );
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  const active = await fixture.request('anonymous', 'GET', '/v1/presentation/active');
  expect(active.status).toBe(200);
  const activated = await fixture.request(
    'steward',
    'POST',
    `/v1/presentation/profiles/${published.body.digest}:activate`,
    { expected_head: active.body.head },
    discoveryKey(),
  );
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const continuation = cursor ? { node: 'catalogue', cursor } : undefined;
    const response = await fixture.request('anonymous', 'POST', '/v1/pages:read', {
      target: { route: '/selected-books' },
      languages: ['en'],
      ...(continuation ? { continuation } : {}),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
    const reads = response.body.reads as Record<
      string,
      { status: number; body: { subjects: { id: string }[]; next: string | null } }
    >;
    const result = reads[plan.nodes.catalogue!]!;
    expect(result.status).toBe(200);
    noCounts(result.body);
    expect(result.body.subjects).toHaveLength(cursor ? 2 : 24);
    if (cursor) expect(reads[plan.nodes.sibling!]!.status).toBe(204);
    found.push(...result.body.subjects.map(({ id }) => id));
    expect(new Set(found).size).toBe(found.length);
    expect(found.length).toBeLessThanOrEqual(26);
    cursor = result.body.next ?? undefined;
  } while (cursor);
  expect([...found].sort()).toEqual(entries.flatMap(({ books }) => books.map(({ id }) => id)).sort());
}, 60_000);
