import { expect, test } from 'bun:test';
import { InvalidSearchContinuation, pageCompletePublicRelation, SearchContinuationRestart }
  from '../../../services/main/src/modules/work/search-continuation.ts';

const position = { datasetId: 'product' as const,
  dataEpoch: '00000000-0000-4000-8000-000000000001', sequence: '42' };
const rows = Array.from({ length: 105 }, (_, index) => ({
  matchUnit: `urn:rezics:content:match-unit:${index}`, score: 105 - index,
}));
const relation = { resultGrain: 'mainVersion' as const,
  context: 'main-version-default' as const, complete: true as const,
  population: 105, total: 105, results: rows, sourcePosition: position,
  indexGeneration: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000002' };
const request = { profile: 'public-main-phrase-page-v1' as const,
  phrase: '  Galaxy42   phrase ', language: 'en', pageSize: 40 };

test('SEARCH08/SEARCH16: complete bounded pages retain one ordered relation and expire', () => {
  const first = pageCompletePublicRelation(request, relation, 1_000);
  expect(first.relationComplete).toBe(true);
  expect(first.total).toBe(105);
  expect(first.results).toEqual(rows.slice(0, 40));
  expect(first.next?.nextOffset).toBe(40);
  const second = pageCompletePublicRelation({ ...request, continuation: first.next! }, relation, 1_100);
  const third = pageCompletePublicRelation({ ...request, continuation: second.next! }, relation, 1_200);
  expect([...first.results, ...second.results, ...third.results]).toEqual(rows);
  expect(third.next).toBeNull();
  expect(() => pageCompletePublicRelation({ ...request, continuation: first.next! },
    relation, 301_000)).toThrow(SearchContinuationRestart);
});

test('SEARCH08/SEARCH16: changed graph, generation, query or ordered result requires restart', () => {
  const first = pageCompletePublicRelation(request, relation, 1_000);
  const continued = { ...request, continuation: first.next! };
  expect(() => pageCompletePublicRelation(continued, { ...relation,
    sourcePosition: { ...position, sequence: '43' } }, 1_100))
    .toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(continued, { ...relation,
    sourcePosition: { ...position, sequence: '43' }, total: 20,
    results: rows.slice(0, 20) }, 1_100)).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(continued, { ...relation,
    indexGeneration: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000003' },
  1_100)).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...continued, phrase: 'different phrase' },
    relation, 1_100)).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation(continued, { ...relation,
    results: [...rows].reverse() }, 1_100)).toThrow(SearchContinuationRestart);
  expect(() => pageCompletePublicRelation({ ...continued, continuation: {
    ...continued.continuation, nextOffset: 600 } }, relation, 1_100))
    .toThrow(InvalidSearchContinuation);
  expect(() => pageCompletePublicRelation({ ...request,
    profile: 'public-realm-phrase-page-v1',
    context: { kind: 'realm-local', id: 'https://rezics.com/id/11111111-1111-4111-8111-111111111111' } },
  relation, 1_100)).toThrow(InvalidSearchContinuation);
});

test('SEARCH08/SEARCH16: classified and rated page keys bind every authority dimension', () => {
  const context = { kind: 'realm-local' as const,
    id: 'https://rezics.com/id/11111111-1111-4111-8111-111111111111' };
  const rated = { profile: 'public-realm-classified-rated-phrase-page-v1' as const,
    phrase: 'Galaxy42 phrase', language: 'en', pageSize: 40, context,
    sense: 'https://rezics.com/id/22222222-2222-4222-8222-222222222222',
    ratingContext: 'https://rezics.com/id/33333333-3333-4333-8333-333333333333',
    minimumMeanTimes10: 80 };
  const realmRelation = { ...relation, context };
  const first = pageCompletePublicRelation(rated, realmRelation, 1_000);
  const continued = { ...rated, continuation: first.next! };
  expect(pageCompletePublicRelation(continued, realmRelation, 1_100).results)
    .toEqual(rows.slice(40, 80));
  for (const changed of [
    { ...continued, sense: 'https://rezics.com/id/44444444-4444-4444-8444-444444444444' },
    { ...continued, ratingContext: 'https://rezics.com/id/55555555-5555-4555-8555-555555555555' },
    { ...continued, minimumMeanTimes10: 90 },
    { ...continued, context: { ...context,
      id: 'https://rezics.com/id/66666666-6666-4666-8666-666666666666' } },
  ]) {
    expect(() => pageCompletePublicRelation(changed,
      { ...realmRelation, context: changed.context }, 1_100))
      .toThrow(SearchContinuationRestart);
  }
});
