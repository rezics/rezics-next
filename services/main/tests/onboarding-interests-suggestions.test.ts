import { expect, test } from 'bun:test';
import { selectInterestSuggestions } from '../src/modules/onboarding-interests/read.ts';
import { interestKinds, matchingActivityKinds, matchingWorkKinds,
  officialZoneInterests } from '../src/modules/onboarding-interests/kinds.ts';
import type { HomeInterestKind } from '../src/modules/onboarding-interests/contract.ts';

const candidates = [
  { value: 'Fiction', matches: matchingWorkKinds(['https://schema.org/Book'], []),
    languageMatches: 5, official: true, score: 60, index: 0 },
  { value: 'Books', matches: [officialZoneInterests.books!],
    languageMatches: 0, official: true, score: 80, index: 1 },
  { value: 'Software', matches: [officialZoneInterests.software!],
    languageMatches: 0, official: true, score: 80, index: 2 },
  { value: 'AI Workshop', matches: matchingWorkKinds(['https://rezics.com/vocab/PromptTemplate'], []),
    languageMatches: 0, official: true, score: 30, index: 3 },
  { value: 'Kitchen', matches: matchingWorkKinds(['https://schema.org/Recipe'], []),
    languageMatches: 2, official: true, score: 30, index: 4 },
  { value: 'Screen Club', matches: matchingWorkKinds(['https://schema.org/Movie'], []),
    languageMatches: 1, official: false, score: 20, index: 5 },
  { value: 'Readers Forum', matches: matchingActivityKinds('discussion'),
    languageMatches: 1, official: false, score: 20, index: 6 },
  { value: 'Community Fiction', matches: matchingWorkKinds(['https://schema.org/Book'], []),
    languageMatches: 3, official: false, score: 30, index: 7 },
];

const pick = (interests: HomeInterestKind[], pool = candidates, limit = 3) =>
  selectInterestSuggestions(pool, interests, limit);

test('G-374: each interest alone reaches a matching Zone or community Realm', () => {
  const expected = ['Fiction', 'Software', 'AI Workshop', 'Kitchen', 'Screen Club', 'Readers Forum'];
  for (const [index, interest] of interestKinds.entries()) {
    expect(pick([interest])[0]).toEqual({ value: expected[index], interest });
  }
});

test('G-374: official catalogue interests cover source-adopted Books and editorial Software', () => {
  expect(matchingWorkKinds([], [])).toEqual([]);
  expect(officialZoneInterests).toEqual({ fiction: 'books', books: 'books', mods: 'software',
    software: 'software', 'ai-workshop': 'ai', kitchen: 'recipes' });
  expect(officialZoneInterests['community-fiction']).toBeUndefined();
});

test('G-374: books and AI in 简体中文 put Fiction before Books without an unchosen software match', () => {
  const official = candidates.filter(item => item.official);
  expect(pick(['books', 'ai'], official).map(item => item.value)).toEqual(['Fiction', 'Books', 'AI Workshop']);
  expect(pick(['books', 'ai'], official).map(item => item.interest)).toEqual(['books', 'books', 'ai']);
});

test('G-374: language outranks activity within an interest; another selected interest keeps a place', () => {
  const english = candidates.map(item => ({ ...item,
    languageMatches: item.value === 'Books' ? 7 : item.value === 'Fiction' ? 0 : item.languageMatches }));
  expect(pick(['books', 'recipes'], english)[0]).toEqual({ value: 'Books', interest: 'books' });
  expect(pick(['books', 'recipes'], english).some(item => item.value === 'Kitchen')).toBe(true);
});

test('G-374: matching community Realm uses Work type, while unmatched official Zones are popular only', () => {
  const pool = candidates.filter(item => ['Community Fiction', 'Software', 'Screen Club'].includes(item.value));
  expect(pick(['books'], pool)).toEqual([
    { value: 'Community Fiction', interest: 'books' },
    { value: 'Screen Club', interest: null },
    { value: 'Software', interest: null },
  ]);
});

test('G-374: a matching official Zone survives the cap even when a community Realm has more preferred Works', () => {
  const pool = candidates.filter(item => ['Fiction', 'Community Fiction', 'Screen Club', 'Kitchen'].includes(item.value))
    .map(item => ({ ...item, languageMatches: item.value === 'Community Fiction' ? 7 : 0 }));
  expect(pick(['books', 'media', 'recipes'], pool).map(item => item.value)).toContain('Fiction');
  expect(pick(['books', 'media', 'recipes'], pool).map(item => item.interest))
    .toEqual(expect.arrayContaining(['books', 'media', 'recipes']));
});

test('G-374: empty choices use only popular fallback and no fallback displaces a match', () => {
  expect(pick([], candidates, 3).every(item => item.interest === null)).toBe(true);
  expect(pick(['media'])[0]).toEqual({ value: 'Screen Club', interest: 'media' });
});
