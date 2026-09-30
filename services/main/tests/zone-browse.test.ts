import { expect, test } from 'bun:test';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { QueryRejected } from '../src/modules/query/compile.ts';
import { type BrowseCandidate, browseCandidates, filterDocument, textRelevance, readZoneBrowse }
  from '../src/modules/zone-modules/browse.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(950);
const MOD = 'https://rezics.com/vocab/ModPackage', DOC = 'https://schema.org/DigitalDocument';
const BOOK = 'https://schema.org/Book';
const fabric = id(900), forge = id(901);
const candidates: BrowseCandidate[] = [
  { work: id(1), order: 0, title: 'Lumen Lanterns', types: [MOD], concepts: [fabric], status: null, words: null,
    updatedAt: '2026-09-20T00:00:00Z' },
  { work: id(2), order: 1, title: 'Chunk Weaver', types: [MOD], concepts: [forge], status: null, words: null,
    updatedAt: '2026-09-27T00:00:00Z' },
  { work: id(3), order: 2, title: 'Tidy Inventory', types: [MOD], concepts: [fabric], status: null, words: null,
    updatedAt: '2026-09-01T00:00:00Z' },
  { work: id(4), order: 3, title: 'Minecraft shaders: a gentle first setup', types: [DOC], concepts: [],
    status: 'completed', words: 1200, updatedAt: null },
  { work: id(5), order: 4, title: '末班地铁', types: [BOOK], concepts: [], status: 'ongoing', words: 450_000,
    updatedAt: '2026-09-25T00:00:00Z' },
];
const titles = (items: readonly BrowseCandidate[]) => items.map(item => item.title);

test('Conditions within a Facet match any value and Facets match all, with self-excluding counts', () => {
  const { found, facets } = browseCandidates(candidates, { type: [MOD], concept: [fabric] }, null, 'newest');
  expect(titles(found)).toEqual(['Lumen Lanterns', 'Tidy Inventory']);
  expect(facets.concept).toEqual([{ value: fabric, count: 2 }, { value: forge, count: 1 }]);
  expect(titles(browseCandidates(candidates, { conceptExclude: [fabric] }, null, 'newest').found))
    .toEqual(['Chunk Weaver', 'Minecraft shaders: a gentle first setup', '末班地铁']);
  expect(browseCandidates(candidates, { status: ['hiatus'] }, null, 'newest').facets.status)
    .toContainEqual({ value: 'hiatus', count: 0 });
  const excluded = browseCandidates(candidates, { statusExclude: ['completed'] }, null, 'newest');
  expect(titles(excluded.found)).not.toContain('Minecraft shaders: a gentle first setup');
  expect(excluded.facets.status).toContainEqual({ value: 'completed', count: 0 });
});

test('excluded Concepts remain excluded from every Concept count, including overlapping Tags', () => {
  const items = [{ ...candidates[0]!, concepts: [fabric, forge] }, candidates[1]!, candidates[2]!];
  const filter = { conceptExclude: [fabric] };
  const { found, facets } = browseCandidates(items, filter, null, 'newest');
  expect(found.map(item => item.work)).toEqual([id(2)]);
  expect(facets.concept).toEqual([{ value: forge, count: 1 }, { value: fabric, count: 0 }]);
  for (const { value, count } of facets.concept) {
    expect(browseCandidates(items, { ...filter, concept: [value] }, null, 'newest').found).toHaveLength(count);
  }
});

test('status and length bands filter serials, and length bands keep their own order', () => {
  const { found, facets } = browseCandidates(candidates, { status: ['ongoing'] }, null, 'newest');
  expect(titles(found)).toEqual(['末班地铁']);
  expect(facets.status).toEqual([{ value: 'completed', count: 1 }, { value: 'ongoing', count: 1 }]);
  expect(browseCandidates(candidates, {}, null, 'newest').facets.length)
    .toEqual([{ value: '0-99999', count: 1 }, { value: '300000-999999', count: 1 }]);
  expect(titles(browseCandidates(candidates, { length: { min: '100000' } }, null, 'newest').found)).toEqual(['末班地铁']);
  expect(filterDocument({ length: { min: '100000', max: '299999' }, status: ['completed'] }))
    .toEqual({ all: [{ facet: 'status', any: ['completed'] },
      { facet: 'length', range: { min: '100000', max: '299999' } }] });
  expect(filterDocument({ concept: [forge], conceptExclude: [fabric] })).toEqual({ all: [
    { facet: 'concept', any: [forge] }, { facet: 'concept', none: [fabric] }] });
});

test('length ranges preserve inclusive bounds, zero and unknown counts independently of buckets', () => {
  const items = [{ ...candidates[0]!, words: 0 }, { ...candidates[1]!, words: null },
    { ...candidates[2]!, words: 123 }];
  expect(browseCandidates(items, { length: { max: '0' } }, null, 'newest').found.map(item => item.work))
    .toEqual([id(1)]);
  const exact = browseCandidates(items, { length: { min: '123', max: '123' } }, null, 'newest');
  expect(exact.found.map(item => item.work)).toEqual([id(3)]);
  expect(exact.facets.length).toEqual([{ value: '0-99999', count: 2 }]);
  expect(browseCandidates(items, { length: { min: '124' } }, null, 'newest').found).toEqual([]);
});

test('text ranks whole titles, starts and words before inner matches; sorts break ties by adoption', () => {
  expect([textRelevance('lumen lanterns', 'Lumen Lanterns'), textRelevance('lum', 'Lumen Lanterns'),
    textRelevance('lant', 'Lumen Lanterns'), textRelevance('ntern', 'Lumen Lanterns'),
    textRelevance('地铁', '末班地铁'), textRelevance('x', 'Lumen')]).toEqual([4, 3, 2, 1, 1, 0]);
  expect(titles(browseCandidates(candidates, {}, 'in', 'relevance').found))
    .toEqual(['Tidy Inventory', 'Minecraft shaders: a gentle first setup']);
  expect(titles(browseCandidates(candidates, {}, null, 'updated').found)).toEqual(['Chunk Weaver', '末班地铁',
    'Lumen Lanterns', 'Tidy Inventory', 'Minecraft shaders: a gentle first setup']);
});

// Admission must run before any owner/session read, including Realm visibility.
const unread = () => ({ realm: async () => { throw new Error('owner read before admission'); },
  query: async () => { throw new Error('graph read before admission'); } }) as unknown as WorkReadSession;

test('relevance needs text, and an empty length range is refused before any graph read', async () => {
  await expect(readZoneBrowse(unread(), realm, { sort: 'relevance' })).rejects.toBeInstanceOf(QueryRejected);
  await expect(readZoneBrowse(unread(), realm, { length: '500-100' })).rejects.toBeInstanceOf(QueryRejected);
});

test('unknown and removed Conditions refuse before any owner read', async () => {
  for (const query of [{ type: ['https://example.com/Unknown'] }, { loader: ['Fabric'] }]) {
    await expect(readZoneBrowse(unread(), realm, query as never)).rejects.toBeInstanceOf(QueryRejected);
  }
});
