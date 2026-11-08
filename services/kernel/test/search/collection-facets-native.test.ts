import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { FacetDiscovery200Response, FacetDiscoveryRequest } from '../../src/search/facet-discovery-contract.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
const marker = `CollectionFacet${crypto.randomUUID().replaceAll('-', '')}`;
const property = 'schema:author';
const filter = { type: { in: ['schema:Book'] } };
const books: { target: CreatedSubject; book: CreatedSubject }[] = [];
const collections = new Map<string, string>();

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  await fixture.setup.openFeatures(['personal_library', 'search', 'search_advanced']);
  for (let index = 0; index < 105; index++) {
    const target = await fixture.createSubject('schema:Person', `Collection author ${index}`);
    const book = await fixture.createSubject('schema:Book', `${marker} ${index}`);
    await fixture.adopt(book, discoveryStatement(property, target.id));
    books.push({ target, book });
  }
  for (const [name, members] of [
    ['primary', books.slice(0, 102)],
    ['secondary', [books[0]!, books[102]!, books[103]!, books[104]!]],
  ] as const) {
    const created = await fixture.request(
      'alice',
      'POST',
      '/v1/collections',
      { title: `Facet ${name}`, visibility: 'private' },
      discoveryKey(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { collection: { id: string } }).collection.id;
    collections.set(name, id);
    for (const { book } of members) {
      const added = await fixture.request(
        'alice',
        'POST',
        `/v1/collections/${id}/members`,
        { subjectId: book.id },
        discoveryKey(),
      );
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
  }
  await fixture.catchUp(books.flatMap(({ target, book }) => [target, book]));
}, 240_000);

afterAll(async () => {
  if (fixture) await fixture.close();
}, 180_000);

async function ready(request: FacetDiscoveryRequest): Promise<FacetDiscovery200Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fixture.request('alice', 'POST', '/v1/subjects:facets', request);
    if (response.status === 200) return response.body as FacetDiscovery200Response;
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    if (response.status !== 503) throw new Error(`Unexpected facet preparation status: ${response.status}`);
    const body = response.body;
    if (typeof body !== 'object' || body === null || !('code' in body) || typeof body.code !== 'string')
      throw new Error('Facet preparation response has no string code');
    const code = body.code;
    expect(['index_not_ready', 'semantic_not_ready']).toContain(code);
    expect(response.headers.get('retry-after')).toBeTruthy();
    if (Date.now() >= deadline)
      throw new Error(`Collection facet stayed in preparation: ${JSON.stringify(response.body)}`);
    await Bun.sleep(25);
  }
}

function request(collection: string, cursor?: string): FacetDiscoveryRequest {
  return {
    scope: { kind: 'collection', id: collection },
    text: marker,
    filter,
    facets: [{ property, size: 20, ...(cursor ? { cursor } : {}) }],
  };
}

async function collect(collection: string): Promise<FacetDiscovery200Response['facets'][number]['values']> {
  const values: FacetDiscovery200Response['facets'][number]['values'] = [];
  let cursor: string | undefined;
  do {
    const response = await ready(request(collection, cursor));
    expect(Object.keys(response).sort()).toEqual(['as_of', 'facets']);
    const facet = response.facets[0]!;
    expect(facet.property).toBe(property);
    expect(facet.values.length).toBeGreaterThan(0);
    expect(facet.values.length).toBeLessThanOrEqual(20);
    expect(new Set(facet.values.map(({ value }) => value)).size).toBe(facet.values.length);
    if (facet.next !== null) expect(facet.values).toHaveLength(20);
    values.push(...facet.values);
    expect(new Set(values.map(({ value }) => value)).size).toBe(values.length);
    cursor = facet.next ?? undefined;
  } while (cursor);
  expect(values.map(({ value }) => value)).toEqual([...values.map(({ value }) => value)].sort());
  return values;
}

function valuesOf(members: readonly (typeof books)[number][]) {
  return members.map(({ target }) => target.id).sort();
}

test('native Collection facets retain current membership across bounded first and tail pages', async () => {
  const primary = collections.get('primary')!;
  const secondary = collections.get('secondary')!;
  const first = await ready(request(primary));
  const firstFacet = first.facets[0]!;
  expect(firstFacet.values).toHaveLength(20);
  assert(firstFacet.next);

  const secondaryValues = await collect(secondary);
  expect(secondaryValues.map(({ value }) => value)).toEqual(valuesOf([books[0]!, ...books.slice(102, 105)]));

  const denied = await fixture.request('bob', 'POST', '/v1/subjects:facets', request(primary));
  expect(denied.status).toBe(404);

  const addedTarget = await fixture.createSubject('schema:Person', 'Collection author after observation');
  const addedBook = await fixture.createSubject('schema:Book', `${marker} after observation`);
  await fixture.adopt(addedBook, discoveryStatement(property, addedTarget.id));
  await fixture.catchUp([addedTarget, addedBook]);
  const added = await fixture.request(
    'alice',
    'POST',
    `/v1/collections/${primary}/members`,
    { subjectId: addedBook.id },
    discoveryKey(),
  );
  expect(added.status).toBe(201);
  const stale = await fixture.request('alice', 'POST', '/v1/subjects:facets', request(primary, firstFacet.next));
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ code: 'search_restart_required' });

  const primaryValues = await collect(primary);
  expect(primaryValues.map(({ value }) => value)).toEqual(
    valuesOf([...books.slice(0, 102), { target: addedTarget, book: addedBook }]),
  );
  expect(primaryValues.every(({ labels }) => labels.en?.startsWith('Collection author '))).toBe(true);
});
