import { expect, test } from 'vitest';
import { LibraryImportInvalid, parseLibraryImport } from '../features/library/import-csv.ts';
import { matchImportedBook } from '../features/library/import-match.ts';

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
