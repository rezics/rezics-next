import { expect, test } from 'vitest';
import { LibraryImportInvalid, parseLibraryImport } from '../features/library/import-csv.ts';
import { matchImportedBook } from '../features/library/import-match.ts';
import { importSelectedBook } from '../features/library/import-api.ts';
import type { MainClient } from '../features/discover/types.ts';

test('G414: quoted Goodreads reviews, dates, ISBN and shelves survive import parsing', () => {
  const exportText = 'Book Id,Title,Author,ISBN13,My Rating,Date Read,Bookshelves,Exclusive Shelf,My Review\r\n'
    + '1,"Pride, and Prejudice",Jane Austen,"=""9780141439518""",5,2026/02/03,"read, classics",read,'
    + '"Loved it, especially the ending."\r\n';
  expect(parseLibraryImport(exportText)).toEqual({ format: 'goodreads', books: [{ row: 2, sourceId: '1',
    title: 'Pride, and Prejudice', author: 'Jane Austen', isbn: '9780141439518', status: 'read',
    shelves: ['read', 'classics'], rating: 5, startedOn: null, finishedOn: '2026-02-03',
    review: 'Loved it, especially the ending.' }] });
});

test('G414: StoryGraph export keeps read status, fractional rating and read range', () => {
  const csv = 'Title,Authors,ISBN/UID,Read Status,Dates Read,Star Rating,Review,Tags\n'
    + '雨夜书店,林雨,9781234567897,Read,2026/01/01 - 2026/01/10,4.25,记得那场雨,"fiction, local"\n';
  expect(parseLibraryImport(csv).books[0]).toMatchObject({ status: 'read', rating: 4.25,
    startedOn: '2026-01-01', finishedOn: '2026-01-10', review: '记得那场雨',
    shelves: ['fiction', 'local'] });
});

test('G414: ISBN-10 matches an edition ISBN-13 and invalid check digits do not identify a Work', () => {
  const header = 'Title,Authors,ISBN/UID,Read Status\n';
  expect(parseLibraryImport(`${header}Pride and Prejudice,Jane Austen,0141439513,Read\n`).books[0]?.isbn)
    .toBe('9780141439518');
  expect(parseLibraryImport(`${header}Pride and Prejudice,Jane Austen,0141439514,Read\n`).books[0]?.isbn)
    .toBeNull();
  expect(parseLibraryImport(`${header}Pride and Prejudice,Jane Austen,9780141439519,Read\n`).books[0]?.isbn)
    .toBeNull();
});

test('G414: rejects malformed or oversized exports before changing library state', () => {
  expect(() => parseLibraryImport('Title,Author,Exclusive Shelf\n"broken,Jane,read'))
    .toThrow(LibraryImportInvalid);
  expect(() => parseLibraryImport('Title,Author,Exclusive Shelf\nT,A,read\n'.repeat(5_001)))
    .toThrow(LibraryImportInvalid);
});

test('G414: ISBN resolves a title tie; author mismatch asks the reader to choose', () => {
  const book = parseLibraryImport('Title,Author,ISBN13,Exclusive Shelf\n'
    + 'Pride and Prejudice,Jane Austen,9780141439518,read\n').books[0]!;
  const candidates = [
    { work: 'work-a', title: book.title, authors: ['Jane Austen'], isbn13: ['9780141439518'] },
    { work: 'work-b', title: book.title, authors: ['Jane Austen'], isbn13: ['9780141439525'] },
  ];
  expect(matchImportedBook(book, candidates)).toMatchObject({ kind: 'matched', selected: 'work-a', reason: 'isbn' });
  expect(matchImportedBook({ ...book, isbn: null, author: 'Another Author' }, candidates))
    .toMatchObject({ kind: 'ambiguous', selected: null });
  expect(matchImportedBook({ ...book, title: 'Unknown book', isbn: null }, candidates))
    .toMatchObject({ kind: 'not-found', selected: null });
});

test('G414: re-importing a reviewed book leaves its status and private note unchanged', async () => {
  const agent = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000099';
  const work = 'https://rezics.com/id/0194f314-9280-767f-89a6-000000000001';
  const book = parseLibraryImport('Book Id,Title,Author,Exclusive Shelf,Date Read,My Review\n'
    + '1,Pride and Prejudice,Jane Austen,read,2026/01/04,Still a favorite.\n').books[0]!;
  let status: 'read' | null = null, version = 0, note: string | null = null, statusWrites = 0, noteWrites = 0;
  const main = { v1: {
    works: () => ({
      'reader-state': { get: async () => ({ data: { status: { status, version,
        startedOn: null, finishedOn: status ? '2026-01-04' : null },
      rating: { global: null }, customShelves: [] } }) },
      'reader-status': { put: async () => { statusWrites++; status = 'read'; version++;
        return { data: { version } }; } },
    }),
    me: { 'import-reviews': Object.assign(() => ({ put: async ({ text }: { text: string }) => {
      noteWrites++; note = text; return { data: { text } };
    } }), { get: async () => ({ data: { items: note ? [{ text: note }] : [] } }) }) },
  } } as unknown as MainClient;
  const save = () => importSelectedBook(agent, book, { work, rating: null, reviewVisibility: 'private' },
    null, 'en', new Map(), () => main);
  expect((await save()).issues).toEqual([]);
  expect((await save()).issues).toEqual([]);
  expect([statusWrites, noteWrites]).toEqual([1, 1]);
});
