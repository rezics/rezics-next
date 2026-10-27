import { expect, test } from 'bun:test';
import {
  MAX_RELATION_FACET_PROBES,
  MAX_RELATION_FACET_VALUES,
  type IndexedSubject,
  type RelationFacetProbe,
} from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = 'schema:author';
const role = 'schema:role';
const language = 'schema:language';
const subject = (n: number): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements: [],
});

test('relation facet probes are unqualified property/value points and reject qualifier fields', async () => {
  const source = createFakeSource();
  expect(typeof source.matchRelationFacets).toBe('function');
  const book = subject(1);
  const person = id(2, '0123');
  book.statements = [
    { property: author, value: person, qualifiers: [{ property: role, value: id(3) }] },
    { property: author, value: person, qualifiers: [{ property: language, value: id(4) }] },
    { property: author, value: id(5) },
    { property: 'schema:illustrator', value: id(6) },
  ];
  source.put(book);
  source.put({ ...book, id: id(8, '0123') });
  const plain = { subject: book.id, property: author, value: person };
  const probes: readonly RelationFacetProbe[] = [
    plain,
    { ...plain, value: id(99) },
    { ...plain, property: 'schema:publisher' },
    { ...plain, value: id(5) },
    { ...plain, value: id(6) },
    { ...plain, property: 'schema:illustrator', value: id(6) },
    plain,
  ];
  const expected = [true, false, false, true, false, true, true];
  expect(await source.matchRelationFacets(10, probes)).toEqual(expected);
  expect(await source.matchRelationFacets(10, [...probes].reverse())).toEqual([...expected].reverse());
  for (const qualifiers of [[{ property: role, in: [id(3)] }], [], undefined]) {
    const qualified = { ...plain, qualifiers } as unknown as RelationFacetProbe;
    await expect(source.matchRelationFacets(10, [plain, qualified])).rejects.toThrow();
  }
  await expect(source.matchRelationFacets(10, [plain, { ...plain, subject: id(8, '0123') }])).rejects.toThrow();
  await expect(source.matchRelationFacets(18, [plain])).rejects.toThrow();
  await expect(source.matchRelationFacets(10, [{ ...plain, subject: 'not-a-uuid' }])).rejects.toThrow();
});

test('relation facet probes are bounded and omit undisclosed subjects', async () => {
  const source = createFakeSource();
  expect(typeof source.matchRelationFacets).toBe('function');
  expect(MAX_RELATION_FACET_VALUES).toBe(128);
  expect(MAX_RELATION_FACET_PROBES).toBe(256);
  const book = subject(1);
  book.statements = Array.from({ length: MAX_RELATION_FACET_VALUES + 1 }, (_, index) => ({
    property: author,
    value: id(index + 100, '0123'),
    facet: { kind: 'item' },
  }));
  source.put(book);
  source.put({ ...book, id: id(2), visibility: 'hidden' });
  source.put({ ...book, id: id(3), visibility: 'taken_down' });
  source.put({ ...book, id: id(4), redirect: book.id });
  source.put({ ...book, id: id(5) });
  source.remove(id(5));
  const probe = { subject: book.id, property: author, value: book.statements[MAX_RELATION_FACET_VALUES]!.value };
  expect(
    await source.matchRelationFacets(
      10,
      Array.from({ length: MAX_RELATION_FACET_PROBES }, () => probe),
    ),
  ).toEqual(Array(MAX_RELATION_FACET_PROBES).fill(true));
  await expect(
    source.matchRelationFacets(
      10,
      Array.from({ length: MAX_RELATION_FACET_PROBES + 1 }, () => probe),
    ),
  ).rejects.toThrow();
  expect(
    await source.matchRelationFacets(10, [probe, ...[2, 3, 4, 5, 6].map((n) => ({ ...probe, subject: id(n) }))]),
  ).toEqual([true, false, false, false, false, false]);
  expect(await source.matchRelationFacets(10, [])).toEqual([]);
  for (const partition of [-1, 4096, 10.5, NaN]) {
    await expect(source.matchRelationFacets(partition, [])).rejects.toThrow();
  }
});
