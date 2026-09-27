import { expect, test } from 'bun:test';
import { searchPageCredits, searchPageSerial } from '../src/modules/search/result-cards.ts';
import { metadataComponent } from '../src/modules/work/metadata-schema.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const field = (value: string) => ({ value });

test('search card batch selects localized serial metadata and the matching graph position stats', async () => {
  const work = id(1);
  const state = { kind: 'header', originalTitle: null, completionStatus: 'completed',
    localized: [{ language: 'en', title: null, description: null, mainVersionLabel: null,
      tagline: 'A complete story' }] };
  const component = metadataComponent(work, state as Parameters<typeof metadataComponent>[1]);
  const session = { query: async (_body: string, limit: number) => {
    expect(limit).toBe(2);
    return [{ work: field(work), head: field(id(2)), component: field(component),
      state: field(JSON.stringify(state)) }];
  }, options: { language: 'en' }, position: { sequence: '42' },
  deps: { serialStats: { batch: async (works: string[], sequence: string) => {
    expect(works).toEqual([work]);
    expect(sequence).toBe('42');
    return new Map([[work, { chapterCount: 7, wordCount: 900,
      lastUpdatedAt: '2026-09-27T00:00:00.000Z' }]]);
  } } } } as unknown as WorkReadSession;
  expect((await searchPageSerial(session, [work])).get(work)).toMatchObject({
    tagline: { value: 'A complete story', language: 'en' }, completionStatus: 'completed',
    chapterCount: 7, wordCount: 900 });
  const damaged = { ...session, query: async () => [{ work: field(work), head: field(id(2)) }] } as unknown as WorkReadSession;
  await expect(searchPageSerial(damaged, [work])).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('search credit batch caps each card while retaining later Works in the same page', async () => {
  const one = id(1), two = id(2);
  const session = { query: async (_body: string, limit: number) => {
    expect(limit).toBe(192);
    return [1, 2, 3, 4].map(n => ({ work: field(one), id: field(id(n + 2)),
      key: field(`/authors/OL${n}A`), ordinal: field(String(n)) }))
      .concat([{ work: field(two), id: field(id(9)), key: field('/authors/OL9A'), ordinal: field('1') }]);
  } } as unknown as WorkReadSession;
  const cards = await searchPageCredits(session, [one, two]);
  expect(cards.get(one)).toHaveLength(3);
  expect(cards.get(two)).toMatchObject([{ key: '/authors/OL9A' }]);
});
