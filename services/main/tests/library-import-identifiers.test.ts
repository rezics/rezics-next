import { expect, test } from 'bun:test';
import { matchLibraryRow } from '../src/modules/library-import/match.ts';
import { librarySourceQueries } from '../src/modules/library-import/identifier-mappings.ts';
import { emptyRow } from '../src/modules/library-import/formats/contract.ts';
import type { ReaderLibraryImportStore } from '../src/modules/library-import/reader-import.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const otherWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const request = new Request('http://main.local');
const noSource = async (): Promise<Response> => { throw new Error('Identifier matches cannot acquire a source'); };

test('every admitted qualified identifier reaches Release lookup, retaining Work grain and conflicting identities', async () => {
  const row = emptyRow('identifiers', 'Personal title', {});
  row.identifiers = [
    { provider: 'https://myanimelist.net/anime', value: '1' },
    { provider: 'https://myanimelist.net/manga', value: '2' },
    { provider: 'https://catalogue.example/items', value: 'unknown-catalogue' },
  ];
  const lookups: string[] = [];
  const store = { call: async (input: Request) => {
    const query = new URL(input.url).searchParams;
    lookups.push(query.get('provider')!);
    return Response.json({ items: [{ id: 'release', coverage: [{ work: query.get('identifier') === '2' ? otherWork : work }] }], nextCursor: null });
  } } as ReaderLibraryImportStore;
  const match = await matchLibraryRow(store, request, actor, row, noSource);
  expect(lookups).toEqual(row.identifiers.map(i => i.provider));
  expect(match).toMatchObject({ kind: 'ambiguous', work: null, target: null, truncated: false });
  expect(match.candidates.map(c => [c.work, c.target])).toEqual([[work, null], [otherWork, null]]);
});

test('several exact releases for one Work never choose an arbitrary release, and an incomplete identity page stays ambiguous', async () => {
  const row = emptyRow('isbn', 'Personal title', {});
  row.identifiers = [{ provider: 'isbn13', value: '9780306406157' }];
  let nextCursor: string | null = null;
  const store = { call: async (_input: Request) => Response.json({ items: ['one', 'two'].map(id => ({ id, coverage: [{ work }] })), nextCursor }) } as ReaderLibraryImportStore;
  expect(await matchLibraryRow(store, request, actor, row, noSource))
    .toMatchObject({ kind: 'matched', work, target: null, candidates: [{ work, target: null }] });
  nextCursor = 'more';
  expect(await matchLibraryRow(store, request, actor, row, noSource))
    .toMatchObject({ kind: 'ambiguous', work: null, target: null, truncated: true });
});

test('reviewed source mappings allow ISBN and title acquisition without sending unrelated identifiers to another source', () => {
  const row = emptyRow('mapping', 'Personal title', {});
  expect(librarySourceQueries(row, actor)).toEqual([{ actingSubject: actor, title: row.title }]);
  row.identifiers = [{ provider: 'isbn13', value: '9780306406157' }];
  expect(librarySourceQueries(row, actor)).toEqual([{ actingSubject: actor, isbn: '9780306406157' },
    { actingSubject: actor, title: row.title }]);
  for (const provider of ['https://myanimelist.net/anime', 'https://myanimelist.net/manga', 'https://vndb.org/vn',
    'https://catalogue.example/items', 'not-an-admitted-provider']) {
    row.identifiers = [{ provider, value: '1' }];
    expect(librarySourceQueries(row, actor)).toEqual([]);
  }
});
