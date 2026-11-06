import type { PrivacyReductionHead } from '../../../src/semantic/public-filter-source-contract.ts';
import type { QueryPrivacyBarrier, QueryPrivacyHeads } from '../../../src/search/query-privacy.ts';

export function privacyHead(partition = 0, position = 1n): PrivacyReductionHead {
  return { partition, epoch: 1, position };
}

export function privacyHeads(patch: Partial<QueryPrivacyHeads> = {}): QueryPrivacyHeads {
  return {
    routingComplete: true,
    unacknowledged: [],
    changed: [],
    blocking: [],
    ...patch,
  };
}

export function privacyBarrier(patch: Partial<QueryPrivacyBarrier> = {}): QueryPrivacyBarrier {
  return {
    head: privacyHead(),
    scope: 'filter_or_order',
    phase: 'pending',
    ...patch,
  };
}
