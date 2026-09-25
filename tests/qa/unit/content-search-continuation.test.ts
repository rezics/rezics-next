import { expect, test } from 'bun:test';
import { pageCompleteContentRelation } from '../../../services/main/src/modules/content-publication/search-continuation.ts';
import { InvalidSearchContinuation, SearchContinuationRestart }
  from '../../../services/main/src/modules/work/search-continuation.ts';

const rows = Array.from({ length: 105 }, (_, index) => ({
  matchUnit: `urn:rezics:match:content:${index}`, resource: `urn:rezics:content:${index}`,
  variant: `urn:rezics:variant:${index}`, revision: `urn:rezics:revision:${index}`,
  publicationDecision: `urn:rezics:decision:${index}`, language: 'en', score: 105 - index,
}));
const relation = {
  contractVersion: '1' as const, profile: 'public-content-phrase-v1' as const,
  resultGrain: 'content-variant' as const, complete: true as const,
  total: 105, population: 105, results: rows,
  graphPosition: { dataEpoch: 'graph-epoch', sequence: '42' },
  contentPosition: { owner: 'content' as const, dataEpoch: 'content-epoch', sequence: '17' },
  indexGeneration: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000002',
};
const request = { profile: 'public-content-phrase-page-v1' as const,
  phrase: '  Galaxy42   phrase ', language: 'en', pageSize: 40 };

test('SEARCH08/SEARCH16: Content pages retain the complete relation and both owner positions', () => {
  const first = pageCompleteContentRelation(request, relation, 1_000);
  const second = pageCompleteContentRelation({ ...request, continuation: first.next! }, relation, 1_100);
  const third = pageCompleteContentRelation({ ...request, continuation: second.next! }, relation, 1_200);
  expect(first.relationComplete).toBe(true);
  expect(first.total).toBe(105);
  expect([...first.results, ...second.results, ...third.results]).toEqual(rows);
  expect(third.next).toBeNull();
  expect(() => pageCompleteContentRelation({ ...request, continuation: first.next! },
    relation, 301_000)).toThrow(SearchContinuationRestart);
});

test('SEARCH08/SEARCH16: Content, graph, index, query and ordered result changes restart', () => {
  const first = pageCompleteContentRelation(request, relation, 1_000);
  const continued = { ...request, continuation: first.next! };
  for (const changed of [
    { ...relation, graphPosition: { ...relation.graphPosition, sequence: '43' } },
    { ...relation, contentPosition: { ...relation.contentPosition, sequence: '18' } },
    { ...relation, indexGeneration: `${relation.indexGeneration}-changed` },
    { ...relation, results: [...rows].reverse() },
  ]) {
    expect(() => pageCompleteContentRelation(continued, changed, 1_100))
      .toThrow(SearchContinuationRestart);
  }
  expect(() => pageCompleteContentRelation({ ...continued, phrase: 'other phrase' },
    relation, 1_100)).toThrow(SearchContinuationRestart);
  expect(() => pageCompleteContentRelation({ ...continued, continuation: {
    ...first.next!, nextOffset: 600 } }, relation, 1_100))
    .toThrow(InvalidSearchContinuation);
});
