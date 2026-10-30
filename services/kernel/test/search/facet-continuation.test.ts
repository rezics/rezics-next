import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { FilterDocument } from '@rezics/filter';
import type { FacetDiscovery200Response, FacetDiscoveryRequest } from '../../src/search/facet-discovery-contract.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
const text = `Facetcontinuation${crypto.randomUUID().replaceAll('-', '')}`;
const property = 'schema:author';
const filter: FilterDocument = { type: { in: ['schema:Book'] } };
const entries: { target: CreatedSubject; book: CreatedSubject; label: string }[] = [];

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  for (let index = 0; index < 21; index++) {
    const name = `Author ${String(21 - index).padStart(2, '0')}`;
    const target = await fixture.createSubject('schema:Person', name);
    const book = await fixture.createSubject('schema:Book', `${text} ${index}`);
    await fixture.adopt(book, discoveryStatement(property, target.id));
    entries.push({ target, book, label: `${name} — controlled discovery test case` });
  }
  await fixture.catchUp(entries.flatMap(({ target, book }) => [target, book]));
}, 120_000);

afterAll(async () => {
  if (fixture) await fixture.close();
}, 180_000);

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}

/** Validate the actual HTTP wire, including required next and the absence of count substitutes. */
function page(body: Record<string, unknown>): FacetDiscovery200Response {
  expect(Object.keys(body).sort()).toEqual(['as_of', 'facets']);
  assert(typeof body.as_of === 'string' && Number.isFinite(Date.parse(body.as_of)));
  assert(Array.isArray(body.facets));
  return {
    as_of: body.as_of,
    facets: body.facets.map((facet: unknown) => {
      record(facet);
      expect(Object.keys(facet).sort()).toEqual(['next', 'property', 'values']);
      assert(typeof facet.property === 'string');
      assert(facet.next === null || (typeof facet.next === 'string' && facet.next.length > 0));
      assert(Array.isArray(facet.values));
      return {
        property: facet.property,
        next: facet.next,
        values: facet.values.map((value: unknown) => {
          record(value);
          expect(Object.keys(value).sort()).toEqual(['labels', 'value']);
          assert(typeof value.value === 'string');
          record(value.labels);
          const labels: Record<string, string> = {};
          for (const [language, label] of Object.entries(value.labels)) {
            assert(typeof label === 'string');
            labels[language] = label;
          }
          return { value: value.value, labels };
        }),
      };
    }),
  };
}

async function ready(body: FacetDiscoveryRequest, persona: DiscoveryPersona = 'anonymous') {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.request(persona, 'POST', '/v1/subjects:facets', body);
    if (response.status === 200) return page(response.body);
    expect(response.status).toBe(503);
    assert(typeof response.body.code === 'string');
    expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
    expect(response.headers.get('retry-after')).toBeTruthy();
    if (Date.now() >= deadline)
      throw new Error(`Facet preparation did not produce a useful page: ${JSON.stringify(response.body)}`);
    await Bun.sleep(25);
  }
}

function expected() {
  return entries
    .map(({ target, label }) => ({ value: target.id, labels: { en: label } }))
    .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
}

async function walk(size?: number) {
  const values: FacetDiscovery200Response['facets'][number]['values'] = [];
  const lengths: number[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const answer = await ready({
      text,
      filter,
      facets: [{ property, ...(size === undefined ? {} : { size }), ...(cursor ? { cursor } : {}) }],
    });
    expect(answer.facets).toHaveLength(1);
    const facet = answer.facets[0]!;
    expect(facet.property).toBe(property);
    expect(facet.values.length).toBeGreaterThan(0);
    expect(facet.values.length).toBeLessThanOrEqual(size ?? 10);
    if (facet.next !== null) {
      expect(facet.values).toHaveLength(size ?? 10);
      expect(seen.has(facet.next)).toBe(false);
      seen.add(facet.next);
    }
    lengths.push(facet.values.length);
    values.push(...facet.values);
    expect(new Set(values.map(({ value }) => value)).size).toBe(values.length);
    expect(values.length).toBeLessThanOrEqual(21);
    cursor = facet.next ?? undefined;
  } while (cursor);
  expect(values).toEqual(expected());
  return { values, lengths };
}

test('21 actual eligible values fill canonical size-2, default-10 and max-20 pages and refine the query', async () => {
  const small = await walk(2);
  expect(small.lengths).toEqual([...Array.from({ length: 10 }, () => 2), 1]);
  expect((await walk()).lengths).toEqual([10, 10, 1]);
  expect((await walk(20)).lengths).toEqual([20, 1]);
  for (const { value } of small.values) {
    const matching = entries.find(({ target }) => target.id === value)!;
    const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
      text,
      filter: { and: [filter, { statement: { property, in: [value] } }] },
      sort: 'id',
    });
    expect(response.status).toBe(200);
    expect(response.body.subjects).toEqual([expect.objectContaining({ id: matching.book.id })]);
  }
}, 60_000);

test('per-property cursors bind principal, effective query, languages and size while siblings can move', async () => {
  const body = { text, filter, facets: [{ property, size: 2 }] };
  const first = await ready(body);
  const cursor = first.facets[0]!.next;
  assert(cursor);
  const continuation = { ...body, facets: [{ property, size: 2, cursor }] };
  for (const [persona, changed] of [
    ['bob', continuation],
    ['anonymous', { ...continuation, text: `${text} changed` }],
    ['anonymous', { ...continuation, filter: { not: filter } }],
    ['anonymous', { ...continuation, languages: ['en'] }],
    ['anonymous', { ...continuation, facets: [{ property, size: 3, cursor }] }],
    ['anonymous', { ...continuation, facets: [{ property: 'type', size: 2, cursor }] }],
  ] satisfies [DiscoveryPersona, FacetDiscoveryRequest][]) {
    const response = await fixture.request(persona, 'POST', '/v1/subjects:facets', changed);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'invalid_request',
      errors: [{ pointer: '/facets/0/cursor', code: 'invalid_format' }],
    });
  }
  const resumed = await ready({
    ...continuation,
    facets: [{ property: 'type' }, ...continuation.facets],
  });
  expect(resumed.facets[0]).toMatchObject({ property: 'type', next: null });
  expect(resumed.facets[0]!.values.map(({ value }) => value)).toEqual(['schema:Book']);
  expect(resumed.facets[1]!.values).toEqual(expected().slice(2, 4));

  const defaults = await ready({ text, filter, facets: [{ property }] });
  const defaultCursor = defaults.facets[0]!.next;
  assert(defaultCursor);
  const explicit = await ready({ text, filter, facets: [{ property, size: 10, cursor: defaultCursor }] });
  expect(explicit.facets[0]!.values).toEqual(expected().slice(10, 20));
}, 60_000);

test('hidden contributors and hidden targets cannot add values through delayed indexing or editor authority', async () => {
  const hiddenContributorValue = await fixture.createSubject('schema:Person', 'Hidden contributor value');
  const hiddenContributor = await fixture.createSubject('schema:Book', `${text} hidden contributor`);
  await fixture.adopt(hiddenContributor, discoveryStatement(property, hiddenContributorValue.id));
  const hiddenTarget = await fixture.createSubject('schema:Person', 'Hidden target');
  const visibleContributor = await fixture.createSubject('schema:Book', `${text} hidden target`);
  await fixture.adopt(visibleContributor, discoveryStatement(property, hiddenTarget.id));
  await fixture.catchUp([hiddenContributorValue, hiddenContributor, hiddenTarget, visibleContributor]);
  await fixture.grant('editor', ['moderation:hide'], hiddenContributor.id);
  await fixture.grant('editor', ['moderation:hide'], hiddenTarget.id);
  const native = fixture.search;
  assert(native);
  await native.indexing('paused');
  try {
    for (const subject of [hiddenContributor, hiddenTarget]) {
      const response = await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${subject.id}:hide`,
        { reason: 'Facet contribution must be currently public' },
        discoveryKey(),
      );
      expect(response.status).toBe(200);
    }
    for (const persona of ['anonymous', 'editor'] as const) {
      const response = await fixture.request(persona, 'POST', '/v1/subjects:facets', {
        text,
        filter,
        facets: [{ property, size: 20 }],
      });
      if (response.status === 200) {
        const result = page(response.body).facets[0]!;
        expect(result.values).toEqual(expected().slice(0, 20));
        expect(result.next).toEqual(expect.any(String));
      } else {
        expect(response.status).toBe(503);
        assert(typeof response.body.code === 'string');
        expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
      }
    }
  } finally {
    await native.indexing('running');
  }
  await fixture.catchUp([visibleContributor, ...entries.map(({ book }) => book)]);
  expect((await walk(2)).values).toEqual(expected());
}, 60_000);
