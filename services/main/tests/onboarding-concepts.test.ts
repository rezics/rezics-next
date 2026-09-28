import { expect, test } from 'bun:test';
import { groupChoices, offeredLanguages, primaryType } from '../src/modules/onboarding/choices.ts';
import { parseLanguages, selectConceptSuggestions } from '../src/modules/onboarding/suggestions.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const book = 'https://schema.org/Book', recipe = 'https://schema.org/Recipe', mod = 'https://rezics.com/vocab/ModPackage',
  software = 'https://schema.org/SoftwareApplication', game = 'https://schema.org/VideoGame';

test('G-431: a Work is grouped by its most specific type: a mod before software, a game before a book', () => {
  expect(primaryType([software, mod])).toBe(mod);
  expect(primaryType([book, game])).toBe(game);
  expect(primaryType(['https://schema.org/DigitalDocument', book])).toBe(book);
  expect(primaryType(['https://example.com/Other'])).toBeNull();
});

test('G-431: content languages start with the reader\'s locale or its language', () => {
  expect(offeredLanguages('zh-Hans')).toEqual(['zh-Hans', 'en', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es']);
  expect(offeredLanguages('fr-CA')[0]).toBe('fr');
  expect(offeredLanguages(undefined)[0]).toBe('en');
  expect(parseLanguages(['ja', 'en'])).toEqual(['ja', 'en']);
  expect(() => parseLanguages(['en', 'en'])).toThrow();
  expect(() => parseLanguages(['tlh'])).toThrow();
});

test('G-431: Concepts group under their Works\' types, with examples, broader before narrower', () => {
  const sampled = (n: number, order: number, works: [number, string | null][], broader: number | null = null) =>
    ({ concept: id(n), broader: broader === null ? null : id(broader), order,
      works: new Map(works.map(([work, type]) => [id(work), type])) });
  const groups = groupChoices([
    sampled(1, 0, []),
    sampled(2, 1, [[10, book], [11, book], [12, game]], 1),
    sampled(3, 2, [[20, recipe]]),
    sampled(4, 3, [[10, book], [30, null]], 2),
  ]);
  // A Concept no public Work carries is not offered; Works of no known type show nowhere.
  // The type with most Concepts leads; ties follow type specificity.
  expect(groups.map(group => group.type)).toEqual([book, recipe, game]);
  expect(groups[0]!.members.map(member => [member.concept.concept, member.works])).toEqual([
    [id(2), [id(10), id(11)]], [id(4), [id(10)]]]);
  expect(groups[1]!.members[0]!.works).toEqual([id(20)]);
  expect(groups[2]!.members.map(member => member.concept.concept)).toEqual([id(2)]);
});

test('G-431: at most 24 Concepts show, those with most examples first, in scheme order', () => {
  const concepts = Array.from({ length: 30 }, (_, n) => ({ concept: id(n), broader: null, order: n,
    works: new Map(Array.from({ length: n % 3 + 1 }, (_, w) => [id(100 + n * 4 + w), book] as const)) }));
  const [group] = groupChoices(concepts);
  expect(group!.members).toHaveLength(12);
  const shown = group!.members.map(member => concepts.findIndex(item => item.concept === member.concept.concept));
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
  expect(group!.members.every(member => member.works.length <= 3)).toBe(true);
});

const candidates = [
  { value: 'Fiction Zone', matches: [id(1)], languageMatches: 5, official: true, score: 60, index: 0 },
  { value: 'Kitchen', matches: [id(2)], languageMatches: 2, official: true, score: 30, index: 1 },
  { value: 'Software', matches: [], languageMatches: 0, official: true, score: 80, index: 2 },
  { value: 'Community Fiction', matches: [id(1)], languageMatches: 3, official: false, score: 30, index: 3 },
  { value: 'Screen Club', matches: [], languageMatches: 1, official: false, score: 20, index: 4 },
];

test('G-431: each chosen Concept reaches a matching Zone or Realm before popular ones fill in', () => {
  expect(selectConceptSuggestions(candidates, [id(1), id(2)], 3)).toEqual([
    { value: 'Fiction Zone', concept: id(1) }, { value: 'Community Fiction', concept: id(1) },
    { value: 'Kitchen', concept: id(2) },
  ]);
  expect(selectConceptSuggestions(candidates, [id(2)], 3)).toEqual([
    { value: 'Kitchen', concept: id(2) }, { value: 'Fiction Zone', concept: null },
    { value: 'Community Fiction', concept: null },
  ]);
  // No choices: popular only, and an official Zone is not a match merely for being official.
  expect(selectConceptSuggestions(candidates, [], 3).every(item => item.concept === null)).toBe(true);
});
