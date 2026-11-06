import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import {
  bookWordsGreaterThanOneMillion,
  compileTaggedWorkFilter,
  currentTaggedWorkSubjects,
  evaluateTaggedWorkPredicate,
} from '../../src/search/tagged-work-query.ts';
import { proveCurrentKindCounts, attachKindCountMetadata } from '../../src/search/type-facet.ts';
import type { IndexedStatement, IndexedSubject } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`;
const ln = id(11);
const harem = id(12);
const otherForm = id(13);
const fantasy = id(14);
const otherTag = id(15);
const scheme = id(16);
const child = id(21);

const quantity = (property: string, amount: number, unit = '1'): IndexedStatement => ({
  property,
  value: String(amount),
  facet: { kind: 'quantity', amount, unit },
});
const item = (property: string, value: string, qualifiers?: IndexedStatement['qualifiers']): IndexedStatement => ({
  property,
  value,
  facet: { kind: 'item' },
  ...(qualifiers ? { qualifiers } : {}),
});
const subject = (
  name: string,
  n: number,
  type: string,
  statements: IndexedStatement[],
  patch: Partial<IndexedSubject> = {},
): IndexedSubject & { name: string } => ({
  name,
  id: id(n),
  type,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: name }],
  aliases: [],
  descriptions: [],
  statements,
  ...patch,
});

const books = [
  subject('B-long', 1, 'schema:Book', [
    quantity('schema:wordCount', 1_200_001),
    item('wdt:P7937', ln),
    item('schema:keywords', harem),
    item('schema:genre', fantasy, [
      { property: 'rezics:sourceTagWeight', value: '3', facet: { kind: 'quantity', amount: 3, unit: '1' } },
      { property: 'rezics:sourceTagWeightMetric', value: 'vndbTagsRating' },
      { property: 'rezics:spoilerLevel', value: '0' },
    ]),
  ]),
  subject('B-edge', 2, 'schema:Book', [
    quantity('schema:wordCount', 1_000_000),
    item('wdt:P7937', ln),
    item('schema:keywords', harem),
    item('schema:genre', fantasy),
  ]),
  subject('B-short', 3, 'schema:Book', [quantity('schema:wordCount', 999_999), item('wdt:P7937', otherForm)]),
  subject('B-characters', 4, 'schema:Book', [
    quantity('schema:characterCount', 1_200_001),
    item('wdt:P7937', ln),
    item('schema:keywords', harem),
  ]),
  subject('B-pages', 5, 'schema:Book', [quantity('schema:numberOfPages', 1_200_001), item('wdt:P7937', ln)]),
  subject('B-movie', 6, 'schema:Movie', [
    item('schema:genre', fantasy, [
      { property: 'rezics:sourceTagWeight', value: '4', facet: { kind: 'quantity', amount: 4, unit: '1' } },
    ]),
  ]),
  subject('B-split', 7, 'schema:Book', [
    item('schema:genre', fantasy),
    item('schema:genre', otherTag, [
      { property: 'rezics:sourceTagWeight', value: '5', facet: { kind: 'quantity', amount: 5, unit: '1' } },
    ]),
  ]),
  subject('B-child', 8, 'schema:Book', [item('schema:genre', child)]),
];

const names = (rows: readonly IndexedSubject[]) =>
  rows.map((row) => books.find((book) => book.id === row.id)?.name ?? row.id).sort();

const words: FilterDocument = { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' } } };
const formHarem: FilterDocument = {
  and: [
    { statement: { property: 'wdt:P7937', in: [ln] } },
    { statement: { property: 'schema:keywords', in: [harem] } },
  ],
};
const tagged: FilterDocument = {
  statement: {
    property: 'schema:genre',
    in: [fantasy],
    concept: { scheme },
    qualifiers: [
      { property: 'rezics:sourceTagWeight', range: { gte: 2, unit: '1' } },
      { property: 'rezics:sourceTagWeightMetric', in: ['vndbTagsRating'] },
      { property: 'rezics:spoilerLevel', in: ['0'] },
    ],
  },
};

test('inclusive word-count grammar selects only B-long; pages and characters do not substitute', () => {
  expect(bookWordsGreaterThanOneMillion(1_200_001, '1')).toBe(true);
  expect(bookWordsGreaterThanOneMillion(1_000_000, '1')).toBe(false);
  expect(bookWordsGreaterThanOneMillion(999_999, '1')).toBe(false);
  expect(bookWordsGreaterThanOneMillion(1_200_001, 'Q7727')).toBe(false);
  expect(names(currentTaggedWorkSubjects(books, words))).toEqual(['B-long']);
  expect(
    evaluateTaggedWorkPredicate(
      books.find((book) => book.name === 'B-pages')!,
      words,
    ),
  ).toBe(false);
  expect(
    evaluateTaggedWorkPredicate(
      books.find((book) => book.name === 'B-characters')!,
      words,
    ),
  ).toBe(false);
  expect(
    evaluateTaggedWorkPredicate(
      books.find((book) => book.name === 'B-edge')!,
      words,
    ),
  ).toBe(false);
  const compiled = compileTaggedWorkFilter(words);
  expect(JSON.stringify(compiled.query)).toContain('"facts.amount"');
  expect(JSON.stringify(compiled.query)).toContain('1000001');
});

test('adopted form and tag fixtures intersect as LN+HAREM and combine with words', () => {
  expect(names(currentTaggedWorkSubjects(books, formHarem))).toEqual(['B-characters', 'B-edge', 'B-long']);
  expect(names(currentTaggedWorkSubjects(books, { and: [words, formHarem] }))).toEqual(['B-long']);
});

test('weight, metric and spoiler constrain the same concept statement', () => {
  expect(names(currentTaggedWorkSubjects(books, tagged))).toEqual(['B-long']);
  expect(
    evaluateTaggedWorkPredicate(
      books.find((book) => book.name === 'B-split')!,
      tagged,
    ),
  ).toBe(false);
  expect(
    evaluateTaggedWorkPredicate(
      books.find((book) => book.name === 'B-edge')!,
      tagged,
    ),
  ).toBe(false);
});

test('descendant membership expands exact tags through the retained concept cut', () => {
  const remaining: FilterDocument = {
    statement: {
      property: 'schema:genre',
      in: [fantasy],
      concept: { scheme, includeChildren: true },
    },
  };
  const withoutCut = currentTaggedWorkSubjects(books, remaining);
  expect(withoutCut).toEqual([]);
  const withCut = currentTaggedWorkSubjects(books, remaining, [
    { property: 'schema:genre', scheme, concept: fantasy, values: new Set([child]) },
  ]);
  expect(names(withCut)).toEqual(['B-child', 'B-edge', 'B-long', 'B-movie', 'B-split']);
});

test('crossed platform language qualifiers match only the same statement', () => {
  const switchId = id(31);
  const pcId = id(32);
  const crossed = subject('R-crossed', 9, 'wd:Q20631656', [
    item('schema:gamePlatform', switchId, [{ property: 'schema:inLanguage', value: 'ja' }]),
    item('schema:gamePlatform', pcId, [{ property: 'schema:inLanguage', value: 'en' }]),
  ]);
  const switchEnglish: FilterDocument = {
    statement: {
      property: 'schema:gamePlatform',
      in: [switchId],
      qualifiers: [{ property: 'schema:inLanguage', in: ['en'] }],
    },
  };
  const switchJapanese: FilterDocument = {
    statement: {
      property: 'schema:gamePlatform',
      in: [switchId],
      qualifiers: [{ property: 'schema:inLanguage', in: ['ja'] }],
    },
  };
  expect(evaluateTaggedWorkPredicate(crossed, switchEnglish)).toBe(false);
  expect(evaluateTaggedWorkPredicate(crossed, switchJapanese)).toBe(true);
});

test('id order continues the remaining form/tag page after the first current row', () => {
  const matched = currentTaggedWorkSubjects(books, formHarem).sort((left, right) => left.id.localeCompare(right.id));
  expect(matched.map((row) => row.id)).toEqual([id(1), id(2), id(4)]);
  const cursor = matched[0]!.id;
  expect(matched.filter((row) => row.id > cursor).map((row) => books.find((book) => book.id === row.id)?.name)).toEqual(
    ['B-edge', 'B-characters'],
  );
});

test('kind chips prove current remaining-predicate membership as N+ and never infer zero', () => {
  const remaining = currentTaggedWorkSubjects(books, { and: [tagged, words] });
  const counts = proveCurrentKindCounts({
    subjects: remaining,
    directory: ['schema:Book', 'schema:Movie', 'schema:Person'],
    complete: false,
  });
  expect(counts.get('schema:Book')).toEqual({ kind: 'schema:Book', value: 1, exact: false });
  expect(counts.get('schema:Movie')).toEqual({ kind: 'schema:Movie', unavailable: true });
  expect(counts.get('schema:Person')).toEqual({ kind: 'schema:Person', unavailable: true });
  const directory = ['schema:Book', 'schema:Movie'].map((kind) => ({
    kind,
    metadata: { id: kind, labels: { en: kind }, icon: 'catalogue' },
  }));
  expect(attachKindCountMetadata(directory, counts)).toEqual([
    {
      id: 'schema:Book',
      labels: { en: 'schema:Book' },
      icon: 'catalogue',
      count: { kind: 'schema:Book', value: 1, exact: false },
    },
    {
      id: 'schema:Movie',
      labels: { en: 'schema:Movie' },
      icon: 'catalogue',
      count: { kind: 'schema:Movie', unavailable: true },
    },
  ]);
});
