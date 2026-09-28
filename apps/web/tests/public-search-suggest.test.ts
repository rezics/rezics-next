import { describe, expect, test } from 'bun:test';
import { offeredFilters } from '../features/search/search-page.tsx';
import type { SearchState } from '../features/search/state.ts';
import { closeness, editDistance, foldText, nearMatches, suggestionPrefixes, tolerance, type TypeaheadItem }
  from '../features/search/suggest.ts';
import { suggestionHref, typeaheadPrefix } from '../features/search/typeahead.tsx';

const work = (n: number) => `https://rezics.com/id/0000000${n}-4b5a-4c6d-8e7f-9a0b1c2d3e4f`;
const item = (n: number, title: string, field: 'title' | 'credit' = 'title', matched = title): TypeaheadItem => ({
  work: work(n), mainVersion: work(n), title: { value: title, language: 'en', direction: 'ltr', basis: 'requested' },
  cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `k${n}`, resourceType: 'work' },
  types: ['https://schema.org/Book'], authors: [], matchedField: field, matchedText: matched, matchedLanguage: 'en' });

describe('search suggestions', () => {
  test('the typeahead is asked for a CJK title’s first character, or a Latin word’s first letters', () => {
    expect(suggestionPrefixes('西油记')).toEqual(['西']);
    expect(suggestionPrefixes('  Pride and Prejudise ')).toEqual(['pre', 'pr']);
    expect(suggestionPrefixes('Émma!')).toEqual(['émm', 'ém']);
    // Too short to be a slip of anything.
    expect(suggestionPrefixes('ab')).toEqual([]);
    expect(suggestionPrefixes('  ')).toEqual([]);
  });

  test('edit distance counts an adjacent swap once', () => {
    expect(editDistance('prejudise', 'prejudice')).toBe(1);
    expect(editDistance('pirde', 'pride')).toBe(1);
    expect(editDistance('西油记', '西游记')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  test('closeness compares the phrase with the nearest run of the candidate from a word start', () => {
    expect(closeness('prejudise', 'Pride and Prejudice')).toBe(1);
    expect(closeness('Pride & Prejudice', 'Pride and Prejudice')).toBeLessThanOrEqual(4);
    expect(closeness('西油', '西游记')).toBe(1);
    expect(foldText('Pride — and “Prejudice”')).toBe('pride and prejudice');
  });

  test('tolerance grows with the phrase: one slip per four letters, one for CJK', () => {
    expect(tolerance('ab')).toBe(0);
    expect(tolerance('emma')).toBe(1);
    expect(tolerance('prejudise')).toBe(2);
    expect(tolerance('西')).toBe(0);
    expect(tolerance('西油记')).toBe(1);
  });

  test('near matches keep close titles and names, nearest first, once each', () => {
    const items = [item(1, 'Pride and Prejudice'), item(2, 'Prelude to Foundation'),
      item(1, 'Pride and Prejudice', 'title', 'Pride and Prejudice'), item(3, 'Emma', 'credit', 'Jane Austen'),
      item(4, 'Persuasion', 'credit', 'Jane Austin')];
    expect(nearMatches('prejudise', items)).toEqual([{ kind: 'work', item: items[0]! }]);
    expect(nearMatches('jane austen', items)).toEqual([{ kind: 'name', name: 'Jane Austen', language: 'en' },
      { kind: 'name', name: 'Jane Austin', language: 'en' }]);
    expect(nearMatches('西油记', [item(6, '西游记')])).toHaveLength(1);
    expect(nearMatches('quantum', items)).toEqual([]);
  });
});

describe('title typeahead', () => {
  test('one CJK character is a prefix; Latin text needs two letters; overlong text none', () => {
    expect(typeaheadPrefix('西')).toBe('西');
    expect(typeaheadPrefix('p')).toBeNull();
    expect(typeaheadPrefix('  pr  ide ')).toBe('pr ide');
    expect(typeaheadPrefix('x'.repeat(81))).toBeNull();
  });

  test('a title opens its Work; a credited name searches for that name', () => {
    expect(suggestionHref(item(1, 'Pride and Prejudice'))).toBe('/w/00000001-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
    expect(suggestionHref(item(3, 'Emma', 'credit', 'Jane Austen'))).toBe('/search?q=Jane%20Austen');
  });
});

describe('search filters', () => {
  const state: SearchState = { phrase: 'pride', scope: { kind: 'global' }, language: null, term: null };
  const facets = { populationBasis: 'all-filters', resultGrain: 'work',
    languages: { precision: 'exact', values: [{ value: 'en', count: 2 }, { value: 'ja', count: 0 }] },
    terms: { precision: 'lower-bound', values: [] },
    types: { precision: 'exact', values: [{ value: 'https://schema.org/Book', count: 2 },
      { value: 'https://schema.org/Recipe', count: 0 }] } } as const;

  test('only languages and kinds with matches are offered', () => {
    const offered = offeredFilters(state, facets as never);
    expect(offered.languages).toEqual(['en']);
    expect(offered.types.map(type => type.key)).toEqual(['book']);
  });

  test('a filter the URL applies stays offered so it can be removed, even at zero', () => {
    const offered = offeredFilters({ ...state, language: 'ja', excludeTypes: ['recipe'] }, facets as never);
    expect(offered.languages).toEqual(['en', 'ja']);
    expect(offered.types.map(type => type.key)).toEqual(['book', 'recipe']);
    expect(offeredFilters(state, undefined)).toEqual({ languages: [], types: [] });
  });
});
