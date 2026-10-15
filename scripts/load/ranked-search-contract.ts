import { deepStrictEqual } from 'node:assert';

// Independent acceptance limits: changing the product declaration cannot relax QA.
export const RANKED_SEARCH_EXPECTED_COST = {
  class: 'bounded-candidate-pool',
  dimension: 'matchingWorks',
  candidates: 512,
  probeRows: 513,
  responseBytes: 1_048_576,
  disclosureBatchSize: 64,
  hydrationBatchSize: 64 / 3,
  rowByteSlack: 1.25,
  growth: {
    mainCalls: { class: 'constant', dimension: 'candidateCount' },
    accountCalls: { class: 'constant', dimension: 'candidateCount' },
    otherFetches: { class: 'constant', dimension: 'candidateCount' },
    unclassifiedFetches: { class: 'constant', dimension: 'candidateCount' },
    fusekiRequests: { class: 'linear', dimension: 'candidateCount',
      reason: 'fixedCalls + ceil(3 * candidates / 64), candidates <= 512' },
    postgresStatements: { class: 'linear', dimension: 'candidateCount',
      reason: 'fixedStatements + ceil(3 * candidates / 64), candidates <= 512' },
    fusekiSentBytes: { class: 'linear', dimension: 'candidateCount', reason: 'Bounded candidate hydration input' },
    fusekiReceivedBytes: { class: 'linear', dimension: 'candidateCount', reason: 'Bounded candidate rows and hydrated cards' },
  },
} as const;

export function assertRankedSearchDeclaration(declaration: unknown): void {
  deepStrictEqual(declaration, RANKED_SEARCH_EXPECTED_COST);
}
