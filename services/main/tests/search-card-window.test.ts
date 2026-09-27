import { expect, test } from 'bun:test';
import { searchCardWindow, SEARCH_CARD_WINDOW } from '../src/modules/search/card-window.ts';
import { pageCompletePublicRelation, SearchContinuationRestart } from '../src/modules/work/search-continuation.ts';
import { Value } from 'typebox/value';
import { publicQueryResult } from '../src/api-contract.ts';

const query = { profile: 'public-main-phrase-v1' as const, phrase: 'bounded cards', language: 'en' };
const relation = { contractVersion: '1', resultGrain: 'mainVersion' as const,
  context: 'main-version-default' as const, complete: true as const, population: 20_000,
  total: 512, indexGeneration: 'generation', sourcePosition: { datasetId: 'product' as const,
    dataEpoch: 'epoch', sequence: '100' }, results: Array.from({ length: 512 }, (_, i) => ({
      work: `work-${i}`, mainVersion: `main-${i}`, matchUnit: `match-${i}`, contribution: `contribution-${i}`,
      revision: `revision-${i}`, selection: `selection-${i}`, language: 'en', score: 1, types: [],
    })), facets: { populationBasis: 'all-filters', resultGrain: 'work',
      languages: { precision: 'exact', values: [{ value: 'en', count: 512 }] },
      terms: { precision: 'lower-bound', values: [] }, types: { precision: 'exact', values: [] } } };

test('512 matches keep exact counts while card continuation visits each bounded window once', () => {
  const window = searchCardWindow(query, relation, 'mutes-1', 1000);
  expect(relation.results).toHaveLength(512);
  expect(window.page.results).toHaveLength(SEARCH_CARD_WINDOW);
  expect(window.page.total).toBe(512);
  expect(Value.Check(publicQueryResult, { ...relation, cardWindow: window.cardWindow })).toBe(true);
  const seen = [...window.page.results];
  let next = window.cardWindow.next;
  while (next) {
    const page = pageCompletePublicRelation(next, relation, 1001, 'mutes-1');
    expect(page.results.length).toBeLessThanOrEqual(20);
    seen.push(...page.results);
    next = page.next ? { ...next, continuation: page.next } : null;
  }
  expect(seen).toEqual(relation.results);
  expect(searchCardWindow(query, { ...relation, total: 0, results: [] }).cardWindow)
    .toEqual({ hydrated: 0, limit: 20, next: null });
});

test('unpaged card continuations bind query, filters, source position, results and reader mutes', () => {
  const next = searchCardWindow(query, relation, 'mutes-1', 1000).cardWindow.next!;
  if (next.profile !== 'public-main-phrase-page-v1') throw new Error('wrong page profile');
  expect(() => pageCompletePublicRelation({ ...next, phrase: 'another query' }, relation, 1001, 'mutes-1'))
    .toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...next, includeTypes: ['https://schema.org/Book'] }, relation, 1001, 'mutes-1'))
    .toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(next, relation, 1001, 'mutes-2')).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(next, { ...relation,
    sourcePosition: { ...relation.sourcePosition, sequence: '101' } }, 1001, 'mutes-1')).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(next, { ...relation, results: [...relation.results].reverse() }, 1001, 'mutes-1'))
    .toThrow(SearchContinuationRestart);
});
