import { expect, test } from 'bun:test';
import {
  postBookPlaceFromRows,
  postBookPlaceQuery,
} from '../src/modules/structure/post-book-placements.ts';
import { workHeader } from '../src/modules/work/read-contract.ts';
import { readWorkHeader } from '../src/modules/work/read-header.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const binding = (value: string) => ({ type: 'uri', value });

test('Work headers carry no chapter placement field', () => {
  expect(workHeader.properties).not.toHaveProperty('partOf');
});

test('Work header hydration stays a Work read and rejects a Post without a Work basis', async () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const queries: string[] = [];
  const session = {
    options: { actingSubject: work },
    principal: {},
    position: { dataEpoch: 'test', sequence: '1' },
    deps: { access: { canReadWork: async () => true } },
    query: async (query: string, maximumRows: number) => {
      queries.push(query);
      expect(maximumRows).toBe(9);
      return [
        {
          head: binding('head'),
          main: binding('main'),
          mainHead: binding('main-head'),
          public: { type: 'literal', value: 'false' },
        },
      ];
    },
    summaries: async () => [
      { status: 'available', type: 'work', name: { value: 'Book', language: 'en' }, avatar: null },
    ],
  } as unknown as WorkReadSession;
  const header = await readWorkHeader(session, work);
  expect(header).toMatchObject({ profile: 'work-read-v1', id: work, title: { value: 'Book' } });
  expect(header).not.toHaveProperty('partOf');
  expect(queries).toHaveLength(1);
  expect(queries[0]).not.toContain('rv:OccurrencePlacement');
  const postSession = { ...session, query: async () => [] } as unknown as WorkReadSession;
  await expect(readWorkHeader(postSession, work)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('Post Book placement requires a Post and the live chapter occurrence', () => {
  const query = postBookPlaceQuery('https://rezics.com/id/00000000-0000-4000-8000-000000000001');
  expect(query).toContain('a rv:Post');
  expect(query).toContain('rv:occurrenceRole rv:ChapterRole');
  expect(query).toContain('rv:generationState rv:Active');
  expect(query).toContain('FILTER NOT EXISTS { ?postPlacement rv:removedBy');
});

test('Post reuse selects an exact occurrence only in one unambiguous Book', () => {
  const one = { book: binding('book'), occurrence: binding('one') };
  expect(postBookPlaceFromRows([])).toBeNull();
  expect(postBookPlaceFromRows([one])).toEqual({ work: 'book', occurrence: 'one' });
  expect(
    postBookPlaceFromRows([one, { book: binding('book'), occurrence: binding('two') }]),
  ).toEqual({ work: 'book', occurrence: null });
  expect(
    postBookPlaceFromRows([one, { book: binding('other'), occurrence: binding('two') }]),
  ).toBeNull();
});
