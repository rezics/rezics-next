import { expect, test } from 'bun:test';
import { conceptResourceMatches } from '../src/modules/query/resources.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import type { DiscoveryReadGeneration } from '../src/modules/discovery/store.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { Pool } from 'pg';
import {
  resourceWorkDrive,
  resourceTypeKinds,
  resourceWorkType,
} from '../src/modules/query/work-drive.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('G1027: compiled and admitted Work subtypes constrain the collector, while mixed owners and exclusions preserve meaning', () => {
  const book = 'https://schema.org/Book',
    extension = 'https://example.org/InteractiveFiction';
  const concept = 'http://www.w3.org/2004/02/skos/core#Concept';
  const definitions = [
    { type: book, base: 'work' },
    { type: extension, base: 'work' },
  ];
  for (const type of [book, extension])
    expect(
      resourceTypeKinds([{ facet: 'type', operator: 'any', values: [type] }], definitions),
    ).toEqual(['work']);
  expect(
    resourceTypeKinds([{ facet: 'type', operator: 'any', values: [book, concept] }], definitions),
  ).toEqual(['work', 'concept']);
  expect(
    resourceTypeKinds([{ facet: 'type', operator: 'all', values: [book, concept] }], definitions),
  ).toEqual([]);
  expect(
    resourceTypeKinds([{ facet: 'type', operator: 'none', values: [book] }], definitions),
  ).toHaveLength(7);
  expect(resourceWorkType([{ facet: 'type', operator: 'any', values: [book] }], definitions)).toBe(
    book,
  );
  expect(
    resourceWorkType([{ facet: 'type', operator: 'any', values: [book, extension] }], definitions),
  ).toBeUndefined();
  expect(
    resourceWorkType([{ facet: 'type', operator: 'all', values: [book, extension] }], definitions),
  ).toBe(book);
});

test('G1027: prepared Concept meaning preserves all/any/none for Works and resource topics', async () => {
  const candidates = [1, 2, 3].map((n) => ({
    id: id(n),
    summary: id(n),
    kind: n === 3 ? ('realm' as const) : ('work' as const),
    order: '',
  }));
  const resolved = new Map(
    [10, 11, 12].map((n) => [id(n), { realm: null, interpretations: [id(n + 10)] }]),
  );
  let queries = 0;
  const session = {
    deps: {
      discovery: {
        termMembership: async () => [
          { work: id(1), term: id(20) },
          { work: id(1), term: id(21) },
          { work: id(2), term: id(20) },
          { work: id(2), term: id(22) },
        ],
      },
    },
    query: async (sparql: string) => {
      expect(sparql).toContain('SELECT ?r ?concept');
      queries++;
      return [10, 11].map((n) => ({ r: { value: id(3) }, concept: { value: id(n) } }));
    },
  } as unknown as WorkReadSession;
  const generation = {} as DiscoveryReadGeneration;
  for (let refill = 0; refill < 8; refill++) {
    expect([
      ...(await conceptResourceMatches(
        session,
        candidates,
        [
          { facet: 'concept', operator: 'all', values: [id(10), id(11)] },
          { facet: 'concept', operator: 'none', values: [id(12)] },
        ],
        undefined,
        generation,
        resolved,
      )),
    ]).toEqual([id(1), id(3)]);
    expect([
      ...(await conceptResourceMatches(
        session,
        candidates,
        [{ facet: 'concept', operator: 'any', values: [id(11), id(12)] }],
        undefined,
        generation,
        resolved,
      )),
    ]).toEqual([id(1), id(2), id(3)]);
  }
  expect(queries).toBe(16);
});

test('G1027: a non-Work window does not open an empty Access membership transaction', async () => {
  const pool = {
    connect() {
      throw new Error('Empty membership attempted SQL');
    },
  } as unknown as Pool;
  expect(
    await new DiscoveryProjection(pool).resourceMembership({} as DiscoveryReadGeneration, []),
  ).toEqual(new Set());
});

test('G1027: positive intersections drive the rarest indexed group; unions retain every interpretation', () => {
  const meaning = new Map([
    [id(10), { interpretations: [id(20), id(21)] }],
    [id(11), { interpretations: [id(22)] }],
    [id(12), { interpretations: [] }],
  ]);
  const counts = new Map([
    [id(10), 1000],
    [id(11), 1],
  ]);
  expect(
    resourceWorkDrive(
      [{ facet: 'concept', operator: 'all', values: [id(10), id(11)] }],
      meaning,
      counts,
      8,
    ),
  ).toEqual([id(22)]);
  expect(
    resourceWorkDrive(
      [{ facet: 'concept', operator: 'any', values: [id(10), id(11)] }],
      meaning,
      counts,
      8,
    ),
  ).toEqual([id(20), id(21), id(22)]);
  expect(
    resourceWorkDrive(
      [{ facet: 'concept', operator: 'none', values: [id(11)] }],
      meaning,
      counts,
      8,
    ),
  ).toEqual(['']);
  expect(
    resourceWorkDrive(
      [{ facet: 'concept', operator: 'all', values: [id(10), id(12)] }],
      meaning,
      counts,
      8,
    ),
  ).toEqual([]);
  expect(
    resourceWorkDrive(
      [{ facet: 'concept', operator: 'any', values: [id(10), id(11)] }],
      meaning,
      counts,
      2,
    ),
  ).toEqual(['']);
});
