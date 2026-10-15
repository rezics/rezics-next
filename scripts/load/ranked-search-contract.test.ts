import { expect, test } from 'bun:test';
import { PUBLIC_SEARCH_PAGE_COST } from '../../services/main/src/modules/work/search-continuation.ts';
import { assertRankedSearchDeclaration } from './ranked-search-contract.ts';

test('ranked-search declarations satisfy independently authored acceptance limits', () => {
  expect(() => assertRankedSearchDeclaration(PUBLIC_SEARCH_PAGE_COST)).not.toThrow();
});

test.each(['candidates', 'probeRows', 'responseBytes', 'disclosureBatchSize', 'hydrationBatchSize', 'rowByteSlack'] as const)(
  'relaxing the product %s cannot relax the growth check', field => {
    expect(() => assertRankedSearchDeclaration({ ...PUBLIC_SEARCH_PAGE_COST,
      [field]: PUBLIC_SEARCH_PAGE_COST[field] * 2 })).toThrow();
  },
);

test('relaxing a growth class cannot relax the check', () => {
  expect(() => assertRankedSearchDeclaration({ ...PUBLIC_SEARCH_PAGE_COST, growth: {
    ...PUBLIC_SEARCH_PAGE_COST.growth, mainCalls: { class: 'linear', dimension: 'candidateCount' },
  } })).toThrow();
});
