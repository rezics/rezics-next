import { expect, test } from 'bun:test';
import { matchesFeedInterest, parseFeedInterests } from '../src/modules/feed/read.ts';
import { WorkReadInvalid } from '../src/modules/work/read-session.ts';

const book = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const software = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const workMatches = new Map([[book, ['books' as const]], [software, ['software' as const]]]);

test('G318: feed interests reject ambiguous, unsupported and empty choices', () => {
  expect(parseFeedInterests(undefined)).toEqual([]);
  expect(parseFeedInterests('books,software')).toEqual(['books', 'software']);
  for (const value of ['', ',books', 'books,', 'books,books', 'Books', 'movies', 'books, software']) {
    expect(() => parseFeedInterests(value)).toThrow(WorkReadInvalid);
  }
});

test('G318: Work interests match typed Works, while discussions match activity only', () => {
  expect(matchesFeedInterest({ kind: 'work', work: book }, ['books'], workMatches)).toBe(true);
  expect(matchesFeedInterest({ kind: 'contribution', work: software }, ['books', 'software'], workMatches)).toBe(true);
  expect(matchesFeedInterest({ kind: 'work', work: software }, ['books'], workMatches)).toBe(false);
  expect(matchesFeedInterest({ kind: 'discussion', work: book }, ['books'], workMatches)).toBe(false);
  expect(matchesFeedInterest({ kind: 'discussion', work: book }, ['discussions'], workMatches)).toBe(true);
  expect(matchesFeedInterest({ kind: 'reply', work: null }, ['discussions'], workMatches)).toBe(true);
  expect(matchesFeedInterest({ kind: 'collection', work: null }, ['books'], workMatches)).toBe(false);
  expect(matchesFeedInterest({ kind: 'collection', work: null }, [], workMatches)).toBe(true);
});
