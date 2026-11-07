import type { PolicyResidual } from '@rezics/access';
import type { CollectionListFilter } from '../library/contract/index.ts';
import type { CollectionListPolicyOutcome } from './contract/index.ts';
import { interpretCollectionListResidual } from './core/index.ts';

export type { CollectionListFilter };

const CURATOR_FILTER: Extract<CollectionListFilter, { source: 'curator' }> = Object.freeze({
  status: 'ready',
  source: 'curator',
  parameters: Object.freeze({}),
});

const PUBLIC_FILTER: Extract<CollectionListFilter, { source: 'public' }> = Object.freeze({
  status: 'ready',
  source: 'public',
  parameters: Object.freeze({ policy_visibility: 'public' as const }),
});

/** Bind Access residual outcomes onto Library's admitted directory parameter map. */
export function bindCollectionListFilter(outcome: CollectionListPolicyOutcome): CollectionListFilter {
  if (outcome.status !== 'ready') return { status: 'unavailable' };
  return outcome.source === 'curator' ? CURATOR_FILTER : PUBLIC_FILTER;
}

/** Lower only the two residual shapes admitted by the current indexed list profile. */
export function lowerCollectionListResidual(residual: PolicyResidual): CollectionListFilter {
  return bindCollectionListFilter(interpretCollectionListResidual(residual));
}
